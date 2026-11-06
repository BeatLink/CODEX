import { describe, expect, it } from 'vitest';

import type { MapNode } from './knowledgeView.js';
import { label, LEVEL_GAP, layoutMindMap, linkPath, MAX_LABEL_CHARS, NODE_HEIGHT, NODE_PADDING, ROW_GAP } from './mindMap.js';

function node(key: string, children: MapNode[] = []): MapNode {
    return { key, choice: { kind: 'all' }, text: key, children };
}

// Ten units a character, so a node's width is easy to work out.
const measure = (text: string): number => text.length * 10;

describe('mind map layout', () => {
    it('centres the root and splits its branches between the right and the left', () => {
        const root = node('root', [node('a'), node('b'), node('c'), node('d')]);

        const { nodes } = layoutMindMap(root, new Set(), measure);
        const place = (key: string) => nodes.find((placed) => placed.node.key === key)!;

        expect(place('root')).toMatchObject({ x: -(40 + NODE_PADDING * 2) / 2, y: 0, side: 0 });
        expect([place('a').side, place('b').side, place('c').side, place('d').side]).toEqual([1, 1, -1, -1]);
        expect(place('a').x).toBe((40 + NODE_PADDING * 2) / 2 + LEVEL_GAP);
        expect(place('c').x + place('c').width).toBe(-((40 + NODE_PADDING * 2) / 2 + LEVEL_GAP));
        expect(place('a').y).toBe(-(NODE_HEIGHT + ROW_GAP) / 2);
        expect(place('b').y).toBe((NODE_HEIGHT + ROW_GAP) / 2);
    });

    it('centres a parent on its children and hides what a folded branch holds', () => {
        const root = node('root', [node('topic', [node('one'), node('two'), node('three')])]);

        const open = layoutMindMap(root, new Set(), measure);
        const folded = layoutMindMap(root, new Set(['topic']), measure);
        const topic = open.nodes.find((placed) => placed.node.key === 'topic')!;
        const ys = open.nodes.filter((placed) => placed.depth === 2).map((placed) => placed.y);

        expect(ys).toEqual([-(NODE_HEIGHT + ROW_GAP), 0, NODE_HEIGHT + ROW_GAP]);
        expect(topic.y).toBe(0);
        expect(open.links).toHaveLength(4);
        expect(folded.nodes.map((placed) => placed.node.key)).toEqual(['root', 'topic']);
        expect(folded.nodes[1].folded).toBe(true);
    });

    it('keeps each branch on its side when another is folded', () => {
        const root = node('root', [node('big', [node('1'), node('2'), node('3')]), node('small'), node('other')]);
        const sides = (folded: Set<string>) => layoutMindMap(root, folded, measure).nodes.filter((placed) => placed.depth === 1).map((placed) => placed.side);

        expect(sides(new Set(['big']))).toEqual(sides(new Set()));
    });

    it('lines each column up on its widest node', () => {
        const root = node('r', [node('t', [node('long-name'), node('x')])]);

        const { nodes } = layoutMindMap(root, new Set(), measure);
        const [, topic, longName, short] = nodes;

        expect(longName.x).toBe(short.x);
        expect(longName.x).toBe(topic.x + topic.width + LEVEL_GAP);
    });

    it('draws a link from past the fold button to the child', () => {
        const root = node('r', [node('t', [node('c')])]);

        const { links } = layoutMindMap(root, new Set(), measure);

        expect(linkPath(links[0])).toMatch(/^M 15 0 C /);
        expect(linkPath(links[1]).startsWith(`M ${links[1].from.x + links[1].from.width + 16} `)).toBe(true);
    });

    it('shortens long labels and flattens their whitespace', () => {
        expect(label('a\n  b')).toBe('a b');
        expect(label('x'.repeat(100))).toHaveLength(MAX_LABEL_CHARS);
    });
});
