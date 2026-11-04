// Turns common Markdown into escaped HTML; anything else stays as written, and only web links become clickable.

const INLINE_MARKDOWN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w))/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;
const LINK_SCHEMES = ['http://', 'https://'];
const MAX_LIST_DEPTH = 4;

// ============================================================================
// Escaping
// ============================================================================

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ============================================================================
// Inline styles
// ============================================================================

export function inlineHtml(text: string): string {
    return text
        .split(INLINE_MARKDOWN)
        .filter((part) => part)
        .map((part) => {
            const link = LINK.exec(part);
            if (link && LINK_SCHEMES.some((scheme) => link[2].startsWith(scheme))) {
                return `<a href="${escapeHtml(link[2])}" target="_blank" rel="noreferrer">${escapeHtml(link[1])}</a>`;
            }
            if (link) {
                return escapeHtml(`${link[1]} (${link[2]})`);
            }
            if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
                return `<strong>${escapeHtml(part.slice(2, -2))}</strong>`;
            }
            if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
                return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
            }
            if ('*_'.includes(part[0]) && part[part.length - 1] === part[0] && part.length > 2) {
                return `<em>${escapeHtml(part.slice(1, -1))}</em>`;
            }
            return escapeHtml(part);
        })
        .join('');
}

// ============================================================================
// Blocks
// ============================================================================

export function markdownToHtml(text: string): string {
    const blocks: string[] = [];
    let paragraph: string[] = [];
    let code: string[] | null = null;

    const endParagraph = (): void => {
        if (paragraph.length > 0) {
            blocks.push(`<p>${paragraph.join('<br>')}</p>`);
            paragraph = [];
        }
    };

    for (const line of text.split(/\r?\n/)) {
        if (line.trimStart().startsWith('```')) {
            if (code === null) {
                endParagraph();
                code = [];
            } else {
                blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
                code = null;
            }
            continue;
        }
        if (code !== null) {
            code.push(line);
            continue;
        }
        const heading = HEADING.exec(line);
        const listItem = LIST_ITEM.exec(line);
        if (heading) {
            endParagraph();
            const level = Math.min(heading[1].length, 3);
            blocks.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`);
        } else if (RULE.test(line)) {
            endParagraph();
            blocks.push('<hr>');
        } else if (listItem) {
            endParagraph();
            const marker = '-*+'.includes(listItem[2]) ? '•' : listItem[2];
            const depth = Math.min(Math.floor(listItem[1].replace(/\t/g, '    ').length / 2), MAX_LIST_DEPTH);
            blocks.push(`<div class="list-item depth-${depth}">${escapeHtml(marker)} ${inlineHtml(listItem[3])}</div>`);
        } else if (line.startsWith('>')) {
            endParagraph();
            blocks.push(`<blockquote>${inlineHtml(line.slice(1).trimStart())}</blockquote>`);
        } else if (!line.trim()) {
            endParagraph();
        } else {
            paragraph.push(inlineHtml(line));
        }
    }
    endParagraph();
    if (code !== null) {
        blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
    }
    return blocks.join('\n');
}
