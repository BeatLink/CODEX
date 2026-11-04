#!/usr/bin/env node
// The codex-daemon command: loads the settings, listens on the socket, and runs the background worker until stopped.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { HelpRequested, parseArguments, usageText, UsageError, type ParserSpec } from '../cli/arguments.js';
import { defaultSettingsPath, loadSettings } from '../core/settings.js';
import { defaultSocketPath } from '../shared/protocol.js';
import { HarnessDaemon } from './daemon.js';

// ============================================================================
// Command line
// ============================================================================

function parserSpec(): ParserSpec {
    return {
        program: 'codex-daemon',
        description: 'Run the CODEX daemon that interfaces connect to.',
        options: [
            { name: 'settings', kind: 'string', default: defaultSettingsPath(), help: 'Path to the JSON settings file.' },
            { name: 'socket', kind: 'string', default: defaultSocketPath(), help: 'Path of the Unix socket to listen on.' },
            {
                name: 'exit-when-unused',
                kind: 'float',
                metavar: 'SECONDS',
                help: 'Exit once no interface has been connected for this long.',
            },
        ],
    };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
    const spec = parserSpec();
    let values;
    try {
        values = parseArguments(spec, argv).values;
    } catch (error) {
        if (error instanceof HelpRequested) {
            console.log(error.text);
            return 0;
        }
        if (error instanceof UsageError) {
            console.error(`${usageText(spec)}\n${spec.program}: error: ${error.message}`);
            return 2;
        }
        throw error;
    }
    const settingsPath = String(values.settings);
    const socketPath = String(values.socket);
    let harness: HarnessDaemon;
    try {
        const settings = loadSettings(settingsPath);
        if (process.env.MODEL_PATH) {
            settings.model_path = process.env.MODEL_PATH;
        }
        harness = new HarnessDaemon(settings, settingsPath, { exitWhenUnusedSeconds: values['exit-when-unused'] as number | null });
        await harness.bind(socketPath);
    } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }

    const stop = (): void => {
        harness.shutdown();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    try {
        harness.startBackgroundWorker();
        console.error(`CODEX daemon listening on ${socketPath}`);
        await harness.serveForever();
    } finally {
        await harness.close();
        process.off('SIGTERM', stop);
        process.off('SIGINT', stop);
    }
    return 0;
}

// ============================================================================
// Entry point
// ============================================================================

function isEntryPoint(): boolean {
    const script = process.argv[1];
    if (!script) {
        return false;
    }
    try {
        return import.meta.url === pathToFileURL(realpathSync(script)).href;
    } catch {
        return false;
    }
}

if (isEntryPoint()) {
    main().then(
        (code) => process.exit(code),
        (error: unknown) => {
            console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        },
    );
}
