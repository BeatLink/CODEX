import { createConnection, type Socket } from 'node:net';

import { buildRequest, type DaemonRequest, type DaemonResponse } from '../shared/protocol.js';

export type DaemonEvent = {
    event: string;
    data?: unknown;
};

export function encodeSocketLine(message: Record<string, unknown>): string {
    return `${JSON.stringify(message)}\n`;
}

export function decodeSocketLine(line: string): DaemonResponse {
    const trimmed = line.trim();
    if (!trimmed) {
        throw new Error('Empty daemon message');
    }

    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object') {
        throw new TypeError('Daemon message must be a JSON object.');
    }

    return parsed as DaemonResponse;
}

export function parseDaemonResult(response: DaemonResponse): unknown {
    if ('result' in response) {
        return response.result;
    }

    if ('error' in response) {
        throw new Error(String(response.error));
    }

    throw new Error(`Unexpected daemon event: ${String((response as { event?: string }).event ?? 'unknown')}`);
}

export class DaemonBridge {
    private socket: Socket | null = null;
    private readonly socketPath: string;
    private readonly pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();

    constructor(socketPath: string) {
        this.socketPath = socketPath;
    }

    async connect(): Promise<void> {
        if (this.socket && !this.socket.destroyed) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const socket = createConnection(this.socketPath);

            socket.once('connect', () => {
                this.socket = socket;
                this.bindSocket(socket);
                resolve();
            });

            socket.once('error', (error) => {
                reject(error as Error);
            });
        });
    }

    private bindSocket(socket: Socket): void {
        socket.on('data', (chunk) => {
            const payload = chunk.toString('utf-8');
            for (const line of payload.split(/\r?\n/)) {
                if (!line.trim()) {
                    continue;
                }

                const message = decodeSocketLine(line);
                if ('event' in message) {
                    continue;
                }

                const key = message.id;
                const waiter = this.pending.get(key);
                if (!waiter) {
                    continue;
                }

                this.pending.delete(key);
                try {
                    waiter.resolve(parseDaemonResult(message));
                } catch (error) {
                    waiter.reject(error as Error);
                }
            }
        });

        socket.on('close', () => {
            this.socket = null;
        });
    }

    async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        await this.connect();

        const request: DaemonRequest = buildRequest(method, params);
        const payload = encodeSocketLine(request);

        return new Promise<T>((resolve, reject) => {
            if (!this.socket) {
                reject(new Error('Daemon socket is not connected.'));
                return;
            }

            this.pending.set(request.id, {
                resolve: (value: any) => resolve(value as T),
                reject: (error: Error) => reject(error),
            });

            this.socket.write(payload, (error) => {
                if (error) {
                    this.pending.delete(request.id);
                    reject(error);
                }
            });
        });
    }

    async close(): Promise<void> {
        if (!this.socket) {
            return;
        }

        await new Promise<void>((resolve) => {
            this.socket?.once('close', () => resolve());
            this.socket?.end();
        });
    }
}
