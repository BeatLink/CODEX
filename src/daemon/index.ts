import { NodeDaemon } from './server.js';

const socketPath = process.env.CODEX_SOCKET_PATH ?? process.env.XDG_RUNTIME_DIR
    ? `${process.env.XDG_RUNTIME_DIR}/codex/daemon.sock`
    : undefined;

const daemon = new NodeDaemon(socketPath);

async function main(): Promise<void> {
    await daemon.listen();
    console.log(`CODEX daemon listening on ${daemon['socketPath'] ?? 'unknown socket'}`);
}

void main();

process.on('SIGINT', () => {
    void daemon.close().finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
    void daemon.close().finally(() => process.exit(0));
});
