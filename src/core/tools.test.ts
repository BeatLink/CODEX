import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Toolbox, extractHtmlText, isPublicAddress, parseSearchResults, validatePublicWebUrl } from './tools.js';

const folders: string[] = [];

function temporaryFolder(): string {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'codex-tools-')));
    folders.push(folder);
    return folder;
}

afterEach(() => {
    for (const folder of folders.splice(0)) {
        rmSync(folder, { recursive: true, force: true });
    }
});

type FakeRequest = { url: string; init: RequestInit | undefined };

// Answers each request from a table of responses keyed by URL, recording what was asked.
function fakeFetch(responses: Record<string, () => Response>, requests: FakeRequest[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        const respond = responses[url];
        if (!respond) {
            throw new Error(`No fake response for ${url}`);
        }
        return respond();
    }) as typeof fetch;
}

const publicHost = async () => ['93.184.216.34'];

// ============================================================================
// Tests and limits
// ============================================================================

describe('toolbox', () => {
    it('runs tests only when enabled, through unittest discovery', async () => {
        const root = temporaryFolder();
        mkdirSync(join(root, 'tests'));
        writeFileSync(
            join(root, 'tests', 'test_sample.py'),
            'import unittest\n\nclass SampleTests(unittest.TestCase):\n    def test_passes(self):\n        self.assertTrue(True)\n',
        );

        const disabled = new Toolbox(root);
        expect(disabled.toolDefinitions.map((tool) => tool.function.name)).not.toContain('run_tests');
        expect(await disabled.call('run_tests', {})).toContain('unknown tool');

        const result = await new Toolbox(root, { enableTestExecution: true }).call('run_tests', {});

        expect(result).toContain('Tests passed');
        expect(result).toContain('Ran 1 test');
    });

    it('needs whole numbers for its limits', () => {
        expect(() => new Toolbox('.', { maxSearchResults: true as never })).toThrow(/max_search_results/);
        expect(() => new Toolbox('.', { maxSearchResults: 2.5 })).toThrow(/max_search_results/);
    });

    it('refuses arguments that are not an object, and unknown or missing ones', async () => {
        const toolbox = new Toolbox(temporaryFolder());

        expect(await toolbox.call('read_file', ['x'])).toBe('Tool error: arguments must be a JSON object.');
        expect(await toolbox.call('read_file', {})).toBe('Tool error: ValueError: missing argument(s): path.');
        expect(await toolbox.call('list_directory', { path: '.', depth: 2 })).toBe('Tool error: ValueError: unknown argument(s): depth.');
    });
});

// ============================================================================
// Files
// ============================================================================

describe('file tools', () => {
    it('read, write and list within the root', async () => {
        const toolbox = new Toolbox(temporaryFolder(), { allowFileWrites: true });

        const written = await toolbox.call('write_file', { path: 'notes/answer.txt', content: 'hello' });

        expect(written).toContain('Wrote');
        expect(await toolbox.call('read_file', { path: 'notes/answer.txt' })).toBe('hello');
        expect(JSON.parse(await toolbox.call('list_directory', { path: 'notes' }))).toEqual([{ name: 'answer.txt', type: 'file' }]);
        expect(toolbox.usedTools).toEqual(new Set(['write_file', 'read_file', 'list_directory']));
    });

    it('are read-only by default', async () => {
        const root = temporaryFolder();
        const toolbox = new Toolbox(root);

        const result = await toolbox.call('write_file', { path: 'notes.txt', content: 'hello' });

        expect(result).toContain('read-only');
        expect(existsSync(join(root, 'notes.txt'))).toBe(false);
        expect(toolbox.toolDefinitions.map((tool) => tool.function.name)).not.toContain('write_file');
    });

    it('log file writes and test runs without the file content', async () => {
        const toolbox = new Toolbox(temporaryFolder());

        await toolbox.call('write_file', { path: 'notes.txt', content: 'hello' });
        await toolbox.call('read_file', { path: 'notes.txt' });

        expect(toolbox.actionLog).toHaveLength(1);
        const [name, recorded, result] = toolbox.actionLog[0];
        expect([name, recorded]).toEqual(['write_file', { path: 'notes.txt' }]);
        expect(result).toContain('read-only');
    });

    it('accept the root and absolute paths inside it', async () => {
        const root = temporaryFolder();
        writeFileSync(join(root, 'readme.txt'), 'hi');
        const toolbox = new Toolbox(root);

        for (const path of ['', '.', './', root]) {
            expect(JSON.parse(await toolbox.call('list_directory', { path }))).toEqual([{ name: 'readme.txt', type: 'file' }]);
        }
        expect(await toolbox.call('read_file', { path: join(root, 'readme.txt') })).toBe('hi');
        expect(await toolbox.call('read_file', { path: '.' })).toContain('list_directory');
        expect(await toolbox.call('read_file', { path: '/etc/hostname' })).toContain('escapes');
    });

    it('refuse paths outside the root, through links too, and secret files', async () => {
        const root = temporaryFolder();
        const outside = temporaryFolder();
        const toolbox = new Toolbox(root, { allowFileWrites: true });

        expect(await toolbox.call('read_file', { path: '../outside.txt' })).toContain('escapes');

        symlinkSync(outside, join(root, 'outside-link'), 'dir');
        const throughLink = await toolbox.call('write_file', { path: 'outside-link/unsafe.txt', content: 'blocked' });
        expect(throughLink).toContain('escapes');
        expect(existsSync(join(outside, 'unsafe.txt'))).toBe(false);

        expect(await toolbox.call('read_file', { path: '.env' })).toContain('credential or secret');
        expect(await toolbox.call('read_file', { path: 'keys/server.pem' })).toContain('credential or secret');
    });

    it('hide secret files and mark links when listing', async () => {
        const root = temporaryFolder();
        writeFileSync(join(root, '.env'), 'x');
        writeFileSync(join(root, '.env.example'), 'x');
        symlinkSync(join(root, '.env.example'), join(root, 'link'));
        const toolbox = new Toolbox(root);

        const entries = JSON.parse(await toolbox.call('list_directory', {}));

        expect(entries).toEqual([
            { name: '.env.example', type: 'file' },
            { name: 'link', type: 'symlink' },
        ]);
    });

    it("leave the harness's own folder out of listings but still read a named file in it", async () => {
        const root = temporaryFolder();
        mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
        writeFileSync(join(root, '.codex', 'agents', 'notes.md'), 'You work with the notes.');
        writeFileSync(join(root, 'todo.txt'), 'x');
        const toolbox = new Toolbox(root);

        expect(JSON.parse(await toolbox.call('list_directory', {}))).toEqual([{ name: 'todo.txt', type: 'file' }]);
        expect(await toolbox.call('read_file', { path: '.codex/agents/notes.md' })).toContain('You work with the notes.');
    });
});

// ============================================================================
// Web
// ============================================================================

const SEARCH_PAGE = `
<div class="result results_links web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fone&amp;rut=abc">Result &amp; <b>one</b></a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fone">Snippet <b>one</b></a>
</div>
<div class="result result--ad">
  <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.test">Advert</a>
  <a class="result__snippet" href="https://duckduckgo.com/y.js">Buy now</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.test/two">Result two</a>
  <a class="result__snippet" href="https://example.test/two">Snippet two</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.test/three">Result three</a>
</div>`;

describe('web search', () => {
    it('reads titles, addresses and snippets from the results page and skips adverts', () => {
        expect(parseSearchResults(SEARCH_PAGE)).toEqual([
            { title: 'Result & one', url: 'https://example.test/one', snippet: 'Snippet one' },
            { title: 'Result two', url: 'https://example.test/two', snippet: 'Snippet two' },
            { title: 'Result three', url: 'https://example.test/three', snippet: '' },
        ]);
    });

    it('keeps results within the settings and reports them to the callback', async () => {
        const requests: FakeRequest[] = [];
        const reported: Array<[string, unknown[]]> = [];
        const toolbox = new Toolbox('.', {
            maxSearchResults: 2,
            searchCallback: (query, items) => reported.push([query, items]),
            fetch: fakeFetch({ 'https://html.duckduckgo.com/html/': () => new Response(SEARCH_PAGE) }, requests),
        });

        const results = JSON.parse(await toolbox.call('web_search', { query: ' local models ', max_results: 8 }));

        expect(results).toHaveLength(2);
        expect(results[0].title).toBe('Result & one');
        expect(String(requests[0].init?.body)).toContain('q=local+models');
        expect(reported[0][0]).toBe('local models');
        expect(reported[0][1]).toEqual(results);
    });

    it('reports a failed search as a tool error', async () => {
        const toolbox = new Toolbox('.', { fetch: fakeFetch({ 'https://html.duckduckgo.com/html/': () => new Response('', { status: 503 }) }) });

        expect(await toolbox.call('web_search', { query: 'x' })).toBe('Tool error: Error: Web search failed: DuckDuckGo answered with HTTP 503.');
    });
});

describe('web fetch', () => {
    const page =
        '<html><head><title>Research title</title><style>hidden style</style></head><body>' +
        '<main><p>Relevant page content &amp; more.</p><script>if (a < b) { hidden script }</script><br/>Next line</main></body></html>';

    it('extracts readable HTML with the page focus', async () => {
        const requests: FakeRequest[] = [];
        const toolbox = new Toolbox('.', {
            resolveHost: publicHost,
            fetch: fakeFetch(
                { 'https://example.test/article': () => new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) },
                requests,
            ),
        });

        const result = JSON.parse(await toolbox.call('web_fetch', { url: 'https://example.test/article#part', focus: 'dates and findings' }));

        expect(result.title).toBe('Research title');
        expect(result.focus).toBe('dates and findings');
        expect(result.url).toBe('https://example.test/article');
        expect(result.text).toBe('Research title\nRelevant page content & more.\nNext line');
        expect(result.truncated).toBe(false);
        expect(requests[0].init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('refuses private hosts, credentials in the address and other schemes', async () => {
        const toolbox = new Toolbox('.', { resolveHost: async () => ['127.0.0.1'], fetch: fakeFetch({}) });

        expect(await toolbox.call('web_fetch', { url: 'https://example.test/private' })).toContain('public IP addresses');
        expect(await toolbox.call('web_fetch', { url: 'http://[::1]/' })).toContain('public IP addresses');
        expect(await toolbox.call('web_fetch', { url: 'http://someone@example.test/' })).toContain('embedded credentials');
        expect(await toolbox.call('web_fetch', { url: 'file:///etc/hostname' })).toContain('absolute public HTTP or HTTPS URL');
    });

    it('checks every address a page redirects to', async () => {
        const toolbox = new Toolbox('.', {
            resolveHost: async (host) => (host === 'internal.test' ? ['10.0.0.5'] : ['93.184.216.34']),
            fetch: fakeFetch({
                'https://example.test/start': () => new Response(null, { status: 302, headers: { Location: 'https://example.test/next' } }),
                'https://example.test/next': () => new Response(null, { status: 301, headers: { Location: 'http://internal.test/admin' } }),
            }),
        });

        expect(await toolbox.call('web_fetch', { url: 'https://example.test/start' })).toContain('public IP addresses');
    });

    it('follows a public redirect and refuses other content types', async () => {
        const toolbox = new Toolbox('.', {
            resolveHost: publicHost,
            fetch: fakeFetch({
                'https://example.test/old': () => new Response(null, { status: 308, headers: { Location: '/new' } }),
                'https://example.test/new': () => new Response('plain words', { headers: { 'Content-Type': 'text/plain' } }),
                'https://example.test/image': () => new Response('x', { headers: { 'Content-Type': 'image/png' } }),
            }),
        });

        const moved = JSON.parse(await toolbox.call('web_fetch', { url: 'https://example.test/old' }));

        expect(moved).toMatchObject({ url: 'https://example.test/new', title: '', text: 'plain words' });
        expect(await toolbox.call('web_fetch', { url: 'https://example.test/image' })).toContain('unsupported webpage content type: image/png.');
    });

    it('tells public addresses from private ones', async () => {
        const privateAddresses = ['10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1'];

        expect(['8.8.8.8', '2606:4700::1111'].map(isPublicAddress)).toEqual([true, true]);
        expect(privateAddresses.map(isPublicAddress)).toEqual(privateAddresses.map(() => false));
        await expect(validatePublicWebUrl('http://0x7f.1/', publicHost)).rejects.toThrow('public IP addresses');
    });

    it('reads entities, line breaks and hidden parts of a page', () => {
        expect(extractHtmlText('<p>a&nbsp;b &#8217; &#x41;</p><svg><title>x</title><text>drawn</text></svg><div>c</div>')).toEqual({
            title: '',
            text: 'a b ’ A\nc',
        });
    });
});
