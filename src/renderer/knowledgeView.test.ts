import { describe, expect, it } from 'vitest';

import {
    chosenKnowledge,
    factsMarkdown,
    formatTimestamp,
    graphMarkdown,
    knowledgeTreeRows,
    NO_GRAPH_TEXT,
    NO_JOBS_TEXT,
    NO_SOURCES_TEXT,
    queueLines,
    sourcesMarkdown,
} from './knowledgeView.js';

describe('knowledge tree', () => {
    const topics = [
        { id: 1, name: 'Languages', parent_id: null, source_count: 0 },
        { id: 2, name: 'Rust', parent_id: 1, source_count: 1 },
        { id: 3, name: 'Loop A', parent_id: 4, source_count: 0 },
        { id: 4, name: 'Loop B', parent_id: 3, source_count: 0 },
    ];
    const sources = [
        { id: 10, title: 'Rust book', url: 'https://r.dev', topic_id: 2, retrieved_at: 0 },
        { id: 11, title: '', url: 'https://x.dev', topic_id: null, retrieved_at: 0 },
    ];
    const facts = [
        { id: 20, statement: 'Rust has no GC.', confidence: 0.9, status: 'active', topic_id: 2, topic: 'Rust', source_url: 'https://r.dev' },
        { id: 21, statement: 'Languages differ.', confidence: 0.5, status: 'active', topic_id: 1, topic: 'Languages', source_url: null },
    ];

    it('puts each article and finding on its own row under its topic, after the subtopics', () => {
        const rows = knowledgeTreeRows(topics, sources, facts);

        expect(rows).toEqual([
            { choice: { kind: 'all' }, text: 'All topics', depth: 0 },
            { choice: { kind: 'topic', id: 1 }, text: 'Languages  (0)', depth: 0 },
            { choice: { kind: 'topic', id: 2 }, text: 'Rust  (1)', depth: 1 },
            { choice: { kind: 'source', id: 10 }, text: 'Rust book', depth: 2 },
            { choice: { kind: 'fact', id: 20 }, text: 'Rust has no GC.', depth: 2 },
            { choice: { kind: 'fact', id: 21 }, text: 'Languages differ.', depth: 1 },
            { choice: { kind: 'topic', id: 3 }, text: 'Loop A  (0)', depth: 0 },
            { choice: { kind: 'topic', id: 4 }, text: 'Loop B  (0)', depth: 1 },
            { choice: { kind: 'uncategorized' }, text: 'Uncategorized  (1)', depth: 0 },
            { choice: { kind: 'source', id: 11 }, text: 'https://x.dev', depth: 1 },
        ]);
    });

    it('shows a topic, an article with the findings it backs, or a finding with its article', () => {
        expect(chosenKnowledge({ kind: 'topic', id: 2 }, sources, facts)).toEqual({ sources: [sources[0]], facts: [facts[0]] });
        expect(chosenKnowledge({ kind: 'source', id: 10 }, sources, facts)).toEqual({ sources: [sources[0]], facts: [facts[0]] });
        expect(chosenKnowledge({ kind: 'fact', id: 21 }, sources, facts)).toEqual({ sources: [], facts: [facts[1]] });
        expect(chosenKnowledge({ kind: 'uncategorized' }, sources, facts)).toEqual({ sources: [sources[1]], facts: [] });
        expect(chosenKnowledge({ kind: 'all' }, sources, facts)).toEqual({ sources, facts });
    });
});

describe('sources, facts and graph', () => {
    it('writes each source with its topic, date, snippet and summary', () => {
        const retrieved = new Date(2026, 0, 2, 3, 4).getTime() / 1000;

        const text = sourcesMarkdown([
            { id: 1, title: 'Rust book', url: 'https://doc.rust-lang.org', topic: 'Rust', retrieved_at: retrieved, snippet: 'Ownership', summary: 'Covers borrowing' },
            { id: 2, title: '', url: 'https://x.dev', topic: null, retrieved_at: retrieved },
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
            { id: 1, statement: 'Rust has no GC.', confidence: 0.9, status: 'active', topic_id: 1, topic: 'Rust', source_url: 'https://r.dev' },
            { id: 2, statement: 'Old claim.', confidence: 0.25, status: 'superseded', topic_id: 1, topic: 'Rust', source_url: null },
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
