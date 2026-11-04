// Test helpers: a daemon serving on a temporary socket inside the test process, and a log of the events it sends.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_KNOWLEDGE_DB_PATH } from '../core/settings.js';
import { DaemonClient, type EventHandler } from './client.js';
import { HarnessDaemon, type DaemonDependencies } from './daemon.js';

// ============================================================================
// Running daemon
// ============================================================================

export type RunningDaemonOptions = {
    settingsPath?: string | null;
    startWorker?: boolean;
    exitWhenUnusedSeconds?: number | null;
    dependencies?: Partial<DaemonDependencies>;
};

export class RunningDaemon {
    readonly directory: string;
    readonly socketPath: string;
    readonly harness: HarnessDaemon;
    readonly clients: DaemonClient[] = [];
    serving: Promise<void> = Promise.resolve();
    served = false;

    private constructor(settings: Record<string, unknown>, options: RunningDaemonOptions) {
        if (settings.knowledge_db_path === DEFAULT_KNOWLEDGE_DB_PATH) {
            throw new Error("A test daemon must use a temporary knowledge database, never the user's real one.");
        }
        // Unix socket paths are limited to about 100 characters, so this stays short.
        this.directory = mkdtempSync('/tmp/sh-');
        this.socketPath = join(this.directory, 'daemon.sock');
        this.harness = new HarnessDaemon(settings, options.settingsPath ?? join(this.directory, 'settings.json'), {
            exitWhenUnusedSeconds: options.exitWhenUnusedSeconds ?? null,
            dependencies: options.dependencies,
        });
    }

    static async start(settings: Record<string, unknown>, options: RunningDaemonOptions = {}): Promise<RunningDaemon> {
        const daemon = new RunningDaemon(settings, options);
        await daemon.harness.bind(daemon.socketPath);
        daemon.serving = daemon.harness.serveForever().then(() => {
            daemon.served = true;
        });
        if (options.startWorker) {
            daemon.harness.startBackgroundWorker();
        }
        return daemon;
    }

    async client(onEvent: EventHandler | null = null): Promise<DaemonClient> {
        const client = new DaemonClient(this.socketPath, { onEvent });
        await client.connect();
        // The daemon registers a connection before answering anything on it, so after this reply the client hears every broadcast.
        await client.call('status');
        this.clients.push(client);
        return client;
    }

    async stop(): Promise<void> {
        for (const client of this.clients) {
            client.onEvent = null;
            client.close();
        }
        this.harness.shutdown();
        await this.serving;
        await this.harness.close();
        rmSync(this.directory, { recursive: true, force: true });
    }
}

// ============================================================================
// Event log
// ============================================================================

// Collects daemon events and waits for one to arrive.
export class EventLog {
    readonly events: Array<[string, Record<string, unknown>]> = [];
    private readonly listeners = new Set<() => void>();
    readonly handler: EventHandler = (event, data) => {
        this.events.push([event, data]);
        for (const listener of [...this.listeners]) {
            listener();
        }
    };

    names(): string[] {
        return this.events.map(([event]) => event);
    }

    // Long enough for a busy machine; a test that passes never waits this long.
    waitFor(name: string, timeoutSeconds = 30): Promise<Record<string, unknown>> {
        const found = (): Record<string, unknown> | undefined => this.events.find(([event]) => event === name)?.[1];
        return new Promise((resolveWait, rejectWait) => {
            const check = (): void => {
                const data = found();
                if (data !== undefined) {
                    clearTimeout(timer);
                    this.listeners.delete(check);
                    resolveWait(data);
                }
            };
            const timer = setTimeout(() => {
                this.listeners.delete(check);
                rejectWait(new Error(`${name} did not arrive; saw ${JSON.stringify(this.names())}`));
            }, timeoutSeconds * 1000);
            this.listeners.add(check);
            check();
        });
    }
}
