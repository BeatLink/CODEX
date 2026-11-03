import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type DaemonParams = Record<string, unknown>;

export type DaemonMessage = {
    id?: string | null;
    method?: string;
    params?: DaemonParams;
    event?: string;
    data?: unknown;
    result?: unknown;
    error?: string;
};

export class NodeDaemon {
    private readonly socketPath: string;
    private server: Server | null = null;
    private readonly clients = new Set<Socket>();
    private readonly methods: Record<string, (params: DaemonParams, socket: Socket) => unknown>;
    private running = false;
    private settings: Record<string, unknown>;

    constructor(socketPath?: string) {
        this.socketPath = socketPath ?? defaultSocketPath();
        this.settings = {
            background_research_enabled: false,
            knowledge_db_path: join(tmpdir(), 'codex-knowledge.sqlite3'),
            model_path: '',
            mode: 'auto',
        };

        this.methods = {
            status: () => ({ ready: true, background_research_enabled: this.settings.background_research_enabled, model: 'node-daemon' }),
            get_settings: () => this.settings,
            apply_settings: (params) => {
                this.settings = { ...this.settings, ...params };
                return this.settings;
            },
            save_settings: (params) => {
                this.settings = { ...this.settings, ...params };
                return this.settings;
            },
            set_background_enabled: (params) => {
                this.settings.background_research_enabled = Boolean(params.enabled);
                return { enabled: this.settings.background_research_enabled };
            },
            run: (params) => {
                const prompt = typeof params.prompt === 'string' ? params.prompt : '';
                const runId = Date.now();
                this.running = true;
                this.broadcast({ event: 'run.started', data: { run_id: runId, prompt } });
                return { run_id: runId, prompt, status: 'started' };
            },
            cancel: () => {
                this.running = false;
                this.broadcast({ event: 'run.cancelled', data: { run_id: 0 } });
                return { cancelled: true };
            },
            shutdown: () => {
                this.running = false;
                return {};
            },
        };
    }

    async listen(): Promise<void> {
        if (this.server) {
            return;
        }

        const parent = dirname(this.socketPath);
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        try {
            rmSync(this.socketPath, { force: true });
        } catch {
            // ignore cleanup of stale socket files
        }

        this.server = createServer((socket) => {
            this.clients.add(socket);
            let pending = '';

            socket.on('data', (chunk) => {
                pending += String(chunk);
                let newlineIndex = pending.indexOf('\n');
                while (newlineIndex >= 0) {
                    const line = pending.slice(0, newlineIndex).trim();
                    pending = pending.slice(newlineIndex + 1);
                    if (!line) {
                        newlineIndex = pending.indexOf('\n');
                        continue;
                    }

                    this.handleLine(line, socket);
                    newlineIndex = pending.indexOf('\n');
                }
            });

            socket.on('close', () => {
                this.clients.delete(socket);
            });
        });

        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(this.socketPath, () => {
                this.server!.removeListener('error', reject);
                resolve();
            });
        });
    }

    async close(): Promise<void> {
        if (!this.server || !this.server.listening) {
            this.server = null;
            this.clients.clear();
            return;
        }

        await new Promise<void>((resolve, reject) => {
            this.server!.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                try {
                    rmSync(this.socketPath, { force: true });
                } catch {
                    // ignore stale socket cleanup
                }
                resolve();
            });
        });

        this.server = null;
        this.clients.clear();
    }

    private handleLine(line: string, socket: Socket): void {
        let message: DaemonMessage;
        try {
            message = JSON.parse(line) as DaemonMessage;
        } catch (error) {
            this.send(socket, { id: null, error: `Invalid message: ${(error as Error).message}` });
            return;
        }

        const requestId = message.id ?? null;
        const methodName = message.method ?? '';
        const params = (message.params as DaemonParams) ?? {};

        try {
            const handler = this.methods[methodName];
            if (!handler) {
                throw new Error(`Unknown method: ${methodName}`);
            }
            const result = handler(params, socket);
            this.send(socket, { id: requestId, result });
            if (methodName === 'shutdown') {
                void this.close();
            }
        } catch (error) {
            this.send(socket, { id: requestId, error: String((error as Error).message ?? error) });
        }
    }

    private send(socket: Socket, message: DaemonMessage): void {
        socket.write(`${JSON.stringify(message)}\n`);
    }

    private broadcast(message: DaemonMessage): void {
        for (const client of this.clients) {
            client.write(`${JSON.stringify(message)}\n`);
        }
    }
}

export function defaultSocketPath(): string {
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (runtime) {
        return join(runtime, 'codex', 'daemon.sock');
    }
    return join(tmpdir(), `codex-${process.getuid?.() ?? 0}`, 'daemon.sock');
}
