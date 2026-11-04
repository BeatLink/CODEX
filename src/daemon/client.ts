// The connection the CLI uses to reach the daemon, sharing the window's client and its way of starting a daemon.
import {
    CALL_TIMEOUT_SECONDS,
    DISCONNECTED_EVENT,
    DaemonClient,
    DaemonError,
    type DaemonClientOptions,
    type EventHandler,
} from '../main/daemonBridge.js';
import {
    connectToDaemon as connectThroughLifecycle,
    DAEMON_START_TIMEOUT_SECONDS,
    STARTED_DAEMON_EXIT_SECONDS,
    spawnDaemon,
    type SpawnFactory,
} from '../main/daemonLifecycle.js';
import { defaultSocketPath } from '../shared/protocol.js';

export {
    CALL_TIMEOUT_SECONDS,
    DAEMON_START_TIMEOUT_SECONDS,
    DISCONNECTED_EVENT,
    DaemonClient,
    DaemonError,
    STARTED_DAEMON_EXIT_SECONDS,
    spawnDaemon,
    type DaemonClientOptions,
    type EventHandler,
};

// ============================================================================
// Finding or starting the daemon
// ============================================================================

export type ConnectToDaemonOptions = {
    socketPath?: string | null;
    settingsPath?: string | null;
    onEvent?: EventHandler | null;
    start?: boolean;
    spawnImpl?: SpawnFactory;
};

// Connect to a running daemon, starting one first when start is true and none answers.
export async function connectToDaemon(options: ConnectToDaemonOptions = {}): Promise<DaemonClient> {
    const { client } = await connectThroughLifecycle(options.socketPath || defaultSocketPath(), {
        settingsPath: options.settingsPath ?? null,
        onEvent: options.onEvent ?? null,
        start: options.start ?? true,
        spawnImpl: options.spawnImpl,
    });
    return client;
}
