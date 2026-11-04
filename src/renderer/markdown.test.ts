import { describe, expect, it } from 'vitest';

import { inlineHtml, markdownToHtml } from './markdown.js';

describe('inline markdown', () => {
    it('styles bold, code and italic text', () => {
        const html = inlineHtml('**Bold** and `code` and *slanted* and _under_');

        expect(html).toBe('<strong>Bold</strong> and <code>code</code> and <em>slanted</em> and <em>under</em>');
    });

    it('makes only web links clickable', () => {
        const web = inlineHtml('[Docs](https://example.com/a)');
        const local = inlineHtml('[File](file:///etc/passwd)');

        expect(web).toBe('<a href="https://example.com/a" target="_blank" rel="noreferrer">Docs</a>');
        expect(local).toBe('File (file:///etc/passwd)');
    });

    it('escapes HTML and leaves underscores inside words alone', () => {
        const html = inlineHtml('<script>alert(1)</script> snake_case_name');

        expect(html).toBe('&lt;script&gt;alert(1)&lt;/script&gt; snake_case_name');
    });
});

describe('block markdown', () => {
    it('renders headings, lists, quotes, rules and paragraphs', () => {
        const html = markdownToHtml('#### Deep\n- one\n  - two\n1. first\n> quoted\n---\nline a\nline b\n\nnext');

        expect(html.split('\n')).toEqual([
            '<h3>Deep</h3>',
            '<div class="list-item depth-0">• one</div>',
            '<div class="list-item depth-1">• two</div>',
            '<div class="list-item depth-0">1. first</div>',
            '<blockquote>quoted</blockquote>',
            '<hr>',
            '<p>line a<br>line b</p>',
            '<p>next</p>',
        ]);
    });

    it('keeps code blocks as written, even when unclosed', () => {
        const html = markdownToHtml('```ts\nconst a = 1 < 2;\n**not bold**\n```\n```\nopen');

        expect(html).toBe('<pre><code>const a = 1 &lt; 2;\n**not bold**</code></pre>\n<pre><code>open</code></pre>');
    });
});
