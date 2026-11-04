// The daemon's wire format: one JSON object per line, as requests, replies and events.
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Messages
// ============================================================================

// A request is {id, method, params}; its reply is {id, result} or {id, error}; events are {event, data}.
export type DaemonRequest = {
    id: string;
    method: string;
    params: Record<string, unknown>;
};

export type DaemonResponse = { id: string; result: unknown } | { id: string; error: string } | { event: string; data?: unknown };

export function buildRequest(method: string, params: Record<string, unknown> = {}): DaemonRequest {
    return {
        id: `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        method,
        params,
    };
}

export function isSuccessfulResponse(response: DaemonResponse): boolean {
    return 'result' in response;
}

// ============================================================================
// Paths
// ============================================================================

export function defaultSocketPath(): string {
    const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
    if (runtimeDirectory) {
        return join(runtimeDirectory, 'codex', 'daemon.sock');
    }
    return join(tmpdir(), `codex-${process.getuid?.() ?? 0}`, 'daemon.sock');
}

export function defaultLogPath(): string {
    const stateDirectory = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
    return join(stateDirectory, 'codex', 'daemon.log');
}

// ============================================================================
// Framing
// ============================================================================

// Write a message as one UTF-8 line, turning values JSON cannot hold into text.
export function encodeMessage(message: Record<string, unknown>): Buffer {
    const text = JSON.stringify(message, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value));
    return Buffer.from(`${text}\n`, 'utf-8');
}

export function decodeMessage(line: Uint8Array | string): Record<string, unknown> {
    const message: unknown = JSON.parse(typeof line === 'string' ? line : Buffer.from(line).toString('utf-8'));
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        throw new Error('Each message must be a JSON object.');
    }
    return message as Record<string, unknown>;
}
