// A connection to the daemon over its Unix socket: one JSON object per line, replies matched by id, events passed on.
import { createConnection, type Socket } from 'node:net';

export const CALL_TIMEOUT_SECONDS = 30;
export const DISCONNECTED_EVENT = 'daemon.disconnected';

export type DaemonMessage = Record<string, unknown>;
export type EventHandler = (event: string, data: Record<string, unknown>) => void;

export class DaemonError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DaemonError';
    }
}

// ============================================================================
// Framing
// ============================================================================

export function encodeSocketLine(message: DaemonMessage): string {
    return `${JSON.stringify(message)}\n`;
}

export function decodeSocketLine(line: string): DaemonMessage {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('Each message must be a JSON object.');
    }
    return parsed as DaemonMessage;
}

// Collects socket chunks and hands back each whole line, keeping a partial line until the rest arrives.
export class LineReader {
    private buffered = '';
    private readonly decoder = new TextDecoder('utf-8');

    push(chunk: Uint8Array | string): string[] {
        this.buffered += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
        const lines = this.buffered.split('\n');
        this.buffered = lines.pop() ?? '';
        return lines.filter((line) => line.trim() !== '');
    }
}

// ============================================================================
// Client
// ============================================================================

type PendingCall = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

export type DaemonClientOptions = {
    onEvent?: EventHandler | null;
    connectImpl?: (path: string) => Socket;
    callTimeoutSeconds?: number;
};

export class DaemonClient {
    readonly socketPath: string;
    onEvent: EventHandler | null;
    connected = false;
    private socket: Socket | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, PendingCall>();
    private readonly connectImpl: (path: string) => Socket;
    private readonly callTimeoutSeconds: number;

    constructor(socketPath: string, options: DaemonClientOptions = {}) {
        this.socketPath = socketPath;
        this.onEvent = options.onEvent ?? null;
        this.connectImpl = options.connectImpl ?? ((path) => createConnection(path));
        this.callTimeoutSeconds = options.callTimeoutSeconds ?? CALL_TIMEOUT_SECONDS;
    }

    // Connects once; the error keeps its code, such as ENOENT or ECONNREFUSED, so a caller can start a daemon.
    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = this.connectImpl(this.socketPath);
            const failed = (error: Error): void => {
                socket.destroy();
                reject(error);
            };
            socket.once('error', failed);
            socket.once('connect', () => {
                socket.off('error', failed);
                this.socket = socket;
                this.connected = true;
                this.readMessages(socket);
                resolve();
            });
        });
    }

    close(): void {
        this.socket?.end();
        this.socket?.destroy();
    }

    // Sends one request and resolves with its result, or rejects with the daemon's error.
    call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const socket = this.socket;
        if (!this.connected || socket === null) {
            return Promise.reject(new DaemonError('Not connected to the CODEX daemon.'));
        }
        const requestId = this.nextId;
        this.nextId += 1;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new DaemonError(`The daemon did not answer ${method} in time.`));
            }, this.callTimeoutSeconds * 1000);
            this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
            socket.write(encodeSocketLine({ id: requestId, method, params }), (error) => {
                if (error) {
                    this.settle(requestId, null, `Lost the connection to the daemon: ${error.message}`);
                }
            });
        });
    }

    private readMessages(socket: Socket): void {
        const reader = new LineReader();
        socket.on('data', (chunk: Buffer) => {
            for (const line of reader.push(chunk)) {
                this.receive(line);
            }
        });
        socket.on('error', () => undefined);
        socket.once('close', () => {
            this.connected = false;
            this.socket = null;
            for (const requestId of [...this.pending.keys()]) {
                this.settle(requestId, null, 'The daemon closed the connection.');
            }
            this.onEvent?.(DISCONNECTED_EVENT, {});
        });
    }

    private receive(line: string): void {
        let message: DaemonMessage;
        try {
            message = decodeSocketLine(line);
        } catch {
            return;
        }
        if ('event' in message) {
            const data = message.data && typeof message.data === 'object' ? (message.data as Record<string, unknown>) : {};
            this.onEvent?.(String(message.event), data);
            return;
        }
        if (typeof message.id === 'number') {
            const error = message.error === undefined || message.error === null ? null : String(message.error);
            this.settle(message.id, message.result ?? null, error);
        }
    }

    private settle(requestId: number, result: unknown, error: string | null): void {
        const pending = this.pending.get(requestId);
        if (pending === undefined) {
            return;
        }
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        if (error !== null) {
            pending.reject(new DaemonError(error));
        } else {
            pending.resolve(result);
        }
    }
}
