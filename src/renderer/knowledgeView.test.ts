import { describe, expect, it } from 'vitest';

import {
    chosenKnowledge,
    factsMarkdown,
    formatTimestamp,
    graphMarkdown,
    knowledgeTree,
    NO_GRAPH_TEXT,
    NO_JOBS_TEXT,
    NO_SOURCES_TEXT,
    queueLines,
    sourcesMarkdown,
    type MapNode,
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

    it('nests subtopics, then articles and findings, under each topic', () => {
        const outline = (node: MapNode): unknown => [node.key, node.text, ...node.children.map(outline)];

        expect(outline(knowledgeTree(topics, sources, facts))).toEqual([
            'all',
            'All topics',
            ['topic:1', 'Languages  (0)', ['topic:2', 'Rust  (1)', ['source:10', 'Rust book'], ['fact:20', 'Rust has no GC.']], ['fact:21', 'Languages differ.']],
            ['topic:3', 'Loop A  (0)', ['topic:4', 'Loop B  (0)']],
            ['uncategorized', 'Uncategorized  (1)', ['source:11', 'https://x.dev']],
        ]);
    });

    it('shows a topic, an article with the findings it backs, a finding with its article, or a thing with its relationships', () => {
        const graph = [
            { source_kind: 'entity', source: 'Rust', relation: 'uses', target_kind: 'entity', target: 'LLVM', evidence_url: 'https://r.dev' },
            { source_kind: 'topic', source: 'Rust', relation: 'supported_by', target_kind: 'source', target: 'https://r.dev', evidence_url: 'https://r.dev' },
        ];

        expect(chosenKnowledge({ kind: 'topic', id: 2 }, sources, facts, graph)).toEqual({ sources: [sources[0]], facts: [facts[0]], graph });
        expect(chosenKnowledge({ kind: 'source', id: 10 }, sources, facts, graph)).toEqual({ sources: [sources[0]], facts: [facts[0]], graph: [graph[0]] });
        expect(chosenKnowledge({ kind: 'fact', id: 21 }, sources, facts, graph)).toEqual({ sources: [], facts: [facts[1]], graph: [] });
        expect(chosenKnowledge({ kind: 'uncategorized' }, sources, facts, graph)).toEqual({ sources: [sources[1]], facts: [], graph });
        expect(chosenKnowledge({ kind: 'all' }, sources, facts, graph)).toEqual({ sources, facts, graph });
        expect(chosenKnowledge({ kind: 'entity', label: 'LLVM' }, sources, facts, graph)).toEqual({ sources: [sources[0]], facts: [], graph: [graph[0]] });
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
