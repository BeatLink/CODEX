import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expandCommand, isMemoryCommand, loadCommands, runMemoryCommand } from './commands.js';
import { KnowledgeStore } from './knowledge.js';

let base: string;
let config: string;
let root: string;
let store: KnowledgeStore;
const savedConfigHome = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'codex-commands-'));
    config = join(base, 'config');
    root = join(base, 'project');
    mkdirSync(root);
    process.env.XDG_CONFIG_HOME = config;
});

afterEach(() => {
    if (savedConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
    } else {
        process.env.XDG_CONFIG_HOME = savedConfigHome;
    }
    rmSync(base, { recursive: true, force: true });
});

function writeCommand(directory: string, name: string, text: string): void {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.md`), text);
}

function remember(text: string): string {
    return runMemoryCommand(`/remember ${text}`, store, root);
}

// ============================================================================
// Memory commands
// ============================================================================

describe('memory commands', () => {
    beforeEach(() => {
        store = new KnowledgeStore(join(base, 'knowledge.db'));
    });

    it('stores a stated preference with its reason', () => {
        const reply = remember('Answer in British English. Why: I work in the UK.');

        const [memory] = store.memories();
        expect(reply).toContain('Remembered');
        expect([memory.store, memory.statement, memory.reason, memory.origin, memory.scope]).toEqual([
            'user',
            'Answer in British English.',
            'I work in the UK.',
            'user',
            '',
        ]);
    });

    it('keeps a remembered project for this folder', () => {
        remember('project: Porting the parser to Zig');

        const [memory] = store.memories();
        expect([memory.store, memory.scope]).toEqual(['project', root]);
    });

    it('files a memory in the store it names and keeps the old kind words', () => {
        remember('code Run the linter before committing');
        remember('reference Docs live at https://example.test/docs');

        const stores = Object.fromEntries(store.memories().map((memory) => [memory.statement, [memory.store, memory.scope]]));
        expect(stores).toEqual({
            'Run the linter before committing': ['code', ''],
            'Docs live at https://example.test/docs': ['locations', ''],
        });
    });

    it('lists each store under its heading and can show one store', () => {
        remember('software Uses Podman, not Docker');
        remember('Prefers short answers');

        const everything = runMemoryCommand('/memories', store, root);
        const onlySoftware = runMemoryCommand('/memories software', store, root);

        expect(everything).toContain('About the user (user)');
        expect(everything).toContain('Software on this machine (software)');
        expect(onlySoftware).not.toContain('short answers');
        expect(runMemoryCommand('/memories nowhere', store, root)).toContain("no memory store called 'nowhere'");
    });

    it('asks for a number when several memories match the words to forget', () => {
        remember('Use tabs in Go');
        remember('Use tabs in Make');

        const reply = runMemoryCommand('/forget use tabs', store, root);
        expect(reply).toContain('Several memories match');
        expect(store.memories()).toHaveLength(2);

        runMemoryCommand('/forget tabs make', store, root);
        expect(store.memories().map((memory) => memory.statement)).toEqual(['Use tabs in Go']);
    });

    it('lists memories and forgets one by its number', () => {
        remember('reference Docs live at https://example.test/docs');
        const memoryId = store.memories()[0].id;

        expect(runMemoryCommand('/memories', store, root)).toContain(`${memoryId}. Docs live`);
        runMemoryCommand(`/forget ${memoryId}`, store, root);
        expect(runMemoryCommand('/memories', store, root)).toContain('No memories yet');
    });

    it('knows its own commands and says when there is no store', () => {
        expect(isMemoryCommand('  /REMEMBER x')).toBe(true);
        expect(isMemoryCommand('/review x')).toBe(false);

        expect(runMemoryCommand('/memories', null, root)).toContain('There is no knowledge store');
    });
});

// ============================================================================
// Commands the user defines
// ============================================================================

describe('user commands', () => {
    it('fills in a command file’s arguments and picks its mode', () => {
        writeCommand(join(config, 'codex', 'commands'), 'review', '---\ndescription: Review some code\nmode: draft\n---\nReview this for bugs: $ARGUMENTS\n');

        expect(expandCommand('/review parser.py', root, false)).toEqual(['draft', 'Review this for bugs: parser.py']);
        expect(loadCommands(root).get('review')?.description).toBe('Review some code');
    });

    it('lets the folder’s command win and puts arguments after a template without a place', () => {
        writeCommand(join(config, 'codex', 'commands'), 'summary', 'Summarize globally.');
        writeCommand(join(root, '.codex', 'commands'), 'summary', 'Summarize this folder.');

        expect(loadCommands(root).get('summary')?.mode).toBeNull();
        expect(expandCommand('/summary briefly', root, false)).toEqual([null, 'Summarize this folder.\n\nbriefly']);
    });

    it('leaves unknown commands and paths alone', () => {
        expect(expandCommand('/etc/hosts is wrong', root, false)).toEqual([null, '/etc/hosts is wrong']);
        expect(expandCommand('/nothing here', root, false)).toEqual([null, '/nothing here']);
    });

    it('writes the /init file only when writing is allowed', () => {
        expect(expandCommand('/init', root, true)[0]).toBe('execute');
        const [mode, prompt] = expandCommand('/init', root, false);
        expect(mode).toBe('draft');
        expect(prompt).toContain("reply with the file's full text");

        writeFileSync(join(root, 'AGENTS.md'), 'Old rules.');
        expect(expandCommand('/init', root, false)[1]).toContain('AGENTS.md already exists');
    });
});
