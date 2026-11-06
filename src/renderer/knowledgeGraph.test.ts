import { describe, expect, it } from 'vitest';

import { hiddenKeys, knowledgeElements, label, MAX_LABEL_CHARS } from './knowledgeGraph.js';
import { knowledgeTree } from './knowledgeView.js';

const topics = [
    { id: 1, name: 'Languages', parent_id: null, source_count: 0 },
    { id: 2, name: 'Rust', parent_id: 1, source_count: 1 },
];
const sources = [{ id: 10, title: 'Rust book', url: 'https://r.dev', topic_id: 2, retrieved_at: 0 }];
const facts = [{ id: 20, statement: 'Rust has no GC.', confidence: 0.9, status: 'active', topic_id: 2, topic: 'Rust', source_url: 'https://r.dev' }];
const graph = [
    { source_kind: 'topic', source: 'Languages', relation: 'contains', target_kind: 'topic', target: 'Rust', evidence_url: null },
    { source_kind: 'entity', source: 'Rust', relation: 'uses', target_kind: 'entity', target: 'LLVM', evidence_url: 'https://r.dev' },
    { source_kind: 'entity', source: 'Cargo', relation: 'builds', target_kind: 'entity', target: 'Rust', evidence_url: null },
];

describe('knowledge graph elements', () => {
    it('draws the tree, each relationship between things, and the evidence behind them', () => {
        const tree = knowledgeTree(topics, sources, facts);

        const { nodes, links } = knowledgeElements(tree, graph, sources, facts);

        expect(nodes.map((node) => node.id)).toEqual(['all', 'topic:1', 'topic:2', 'source:10', 'fact:20', 'entity:Rust', 'entity:LLVM', 'entity:Cargo']);
        expect(links.map((link) => [link.kind, link.source, link.target, link.label])).toEqual([
            ['tree', 'all', 'topic:1', ''],
            ['tree', 'topic:1', 'topic:2', ''],
            ['tree', 'topic:2', 'source:10', ''],
            ['tree', 'topic:2', 'fact:20', ''],
            ['evidence', 'source:10', 'fact:20', ''],
            ['relation', 'entity:Rust', 'entity:LLVM', 'uses'],
            ['evidence', 'source:10', 'entity:Rust', ''],
            ['evidence', 'source:10', 'entity:LLVM', ''],
            ['relation', 'entity:Cargo', 'entity:Rust', 'builds'],
        ]);
    });

    it('hides everything below a folded branch', () => {
        const tree = knowledgeTree(topics, sources, facts);

        expect([...hiddenKeys(tree, new Set(['topic:1']))]).toEqual(['topic:2', 'source:10', 'fact:20']);
        expect(hiddenKeys(tree, new Set())).toEqual(new Set());
    });

    it('shortens long labels and flattens their whitespace', () => {
        expect(label('a\n  b')).toBe('a b');
        expect(label('x'.repeat(100))).toHaveLength(MAX_LABEL_CHARS);
    });
});
