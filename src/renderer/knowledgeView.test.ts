import { describe, expect, it } from 'vitest';

import {
    factsMarkdown,
    formatTimestamp,
    graphMarkdown,
    NO_GRAPH_TEXT,
    NO_JOBS_TEXT,
    NO_SOURCES_TEXT,
    queueLines,
    sourcesMarkdown,
    topicRows,
} from './knowledgeView.js';

describe('topic rows', () => {
    it('lists parents before their children and keeps topics a loop would hide', () => {
        const topics = [
            { id: 1, name: 'Languages', parent_id: null, source_count: 2 },
            { id: 2, name: 'Rust', parent_id: 1, source_count: 5 },
            { id: 3, name: 'Loop A', parent_id: 4, source_count: 0 },
            { id: 4, name: 'Loop B', parent_id: 3, source_count: 0 },
        ];

        const rows = topicRows(topics);

        expect(rows).toEqual([
            { id: null, text: 'All topics', depth: 0 },
            { id: 1, text: 'Languages  (2)', depth: 0 },
            { id: 2, text: 'Rust  (5)', depth: 1 },
            { id: 3, text: 'Loop A  (0)', depth: 0 },
            { id: 4, text: 'Loop B  (0)', depth: 1 },
        ]);
    });
});

describe('sources, facts and graph', () => {
    it('writes each source with its topic, date, snippet and summary', () => {
        const retrieved = new Date(2026, 0, 2, 3, 4).getTime() / 1000;

        const text = sourcesMarkdown([
            { title: 'Rust book', url: 'https://doc.rust-lang.org', topic: 'Rust', retrieved_at: retrieved, snippet: 'Ownership', summary: 'Covers borrowing' },
            { title: '', url: 'https://x.dev', topic: null, retrieved_at: retrieved },
        ]);

        expect(formatTimestamp(retrieved)).toBe('2026-01-02 03:04');
        expect(text).toBe(
            '### [Rust book](https://doc.rust-lang.org)\nRust | Retrieved 2026-01-02 03:04\n\nOwnership\n\nCovers borrowing' +
                '\n\n---\n\n' +
                '### [https://x.dev](https://x.dev)\nUncategorized | Retrieved 2026-01-02 03:04\n\n\n\n',
        );
        expect(sourcesMarkdown([])).toBe(NO_SOURCES_TEXT);
    });

    it('writes facts with their confidence and evidence', () => {
        const text = factsMarkdown([
            { id: 1, statement: 'Rust has no GC.', confidence: 0.9, status: 'active', topic: 'Rust', source_url: 'https://r.dev' },
            { id: 2, statement: 'Old claim.', confidence: 0.25, status: 'superseded', topic: 'Rust', source_url: null },
        ]);

        expect(text).toBe(
            '- **Rust**: Rust has no GC. _(confidence 0.90)_ ([evidence](https://r.dev))\n' +
                '- **Rust**: Old claim. _(confidence 0.25, superseded)_',
        );
    });

    it('writes at most fifty graph relationships', () => {
        const edges = Array.from({ length: 60 }, (_, index) => ({
            source: `A${index}`,
            relation: 'uses',
            target: 'B',
            evidence_url: index === 0 ? 'https://e.dev' : null,
        }));

        const lines = graphMarkdown(edges).split('\n\n');

        expect(lines).toHaveLength(50);
        expect(lines[0]).toBe('`A0` -uses-> `B` ([evidence](https://e.dev))');
        expect(lines[1]).toBe('`A1` -uses-> `B`');
        expect(graphMarkdown([])).toBe(NO_GRAPH_TEXT);
    });
});

describe('research queue', () => {
    it('writes the newest twenty jobs with their state and any error', () => {
        const jobs = Array.from({ length: 25 }, (_, index) => ({ id: index, topic: `T${index}`, status: index === 0 ? 'failed' : 'pending', error: index === 0 ? 'timeout' : null }));

        const lines = queueLines(jobs).split('\n');

        expect(lines).toHaveLength(20);
        expect(lines[0]).toBe('FAILED   T0  (timeout)');
        expect(lines[1]).toBe('PENDING  T1');
        expect(queueLines([])).toBe(NO_JOBS_TEXT);
    });
});
