// The knowledge page's graph, drawn with Cytoscape and laid out by force: the topic tree around "All topics",
// with relationships between things and the evidence behind findings drawn as extra connections.
import cytoscape from 'cytoscape';

import { choiceKey, isRelationship, type MapNode, type TreeChoice } from './knowledgeView.js';
import type { Fact, GraphEdge, Source } from './types.js';

export const MAX_LABEL_CHARS = 48;
const FIT_PADDING = 30;

// ============================================================================
// Elements
// ============================================================================

// What a graph node or connection stands for; the stylesheet draws each kind differently.
export type ElementKind = TreeChoice['kind'] | 'tree' | 'relation' | 'evidence';

export type GraphNode = { id: string; label: string; text: string; kind: ElementKind; choice: TreeChoice };

export type GraphLink = { id: string; source: string; target: string; kind: ElementKind; label: string };

export type KnowledgeElements = { nodes: GraphNode[]; links: GraphLink[] };

export function label(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_LABEL_CHARS ? `${flat.slice(0, MAX_LABEL_CHARS - 1)}…` : flat;
}

// Turns the topic tree and the stored relationships into graph nodes and connections:
// tree lines from each parent to its children, a named arrow for every relationship between two things,
// and dashed evidence lines from each article to the findings and relationships it supports.
export function knowledgeElements(tree: MapNode, graph: GraphEdge[], sources: Source[], facts: Fact[]): KnowledgeElements {
    const nodes: GraphNode[] = [];
    const links = new Map<string, GraphLink>();
    const link = (source: string, target: string, kind: ElementKind, name = ''): void => {
        const id = `${kind}:${source}>${target}${name ? `:${name}` : ''}`;
        links.set(id, { id, source, target, kind, label: name });
    };
    const walk = (node: MapNode): void => {
        nodes.push({ id: node.key, label: label(node.text), text: node.text, kind: node.choice.kind, choice: node.choice });
        for (const child of node.children) {
            link(node.key, child.key, 'tree');
            walk(child);
        }
    };
    walk(tree);

    const articles = new Map(sources.map((source) => [source.url, choiceKey({ kind: 'source', id: source.id })]));
    for (const fact of facts) {
        const article = fact.source_url ? articles.get(fact.source_url) : undefined;
        if (article !== undefined) {
            link(article, choiceKey({ kind: 'fact', id: fact.id }), 'evidence');
        }
    }

    const entities = new Set<string>();
    for (const edge of graph.filter(isRelationship)) {
        for (const name of [edge.source, edge.target]) {
            if (!entities.has(name)) {
                entities.add(name);
                const choice: TreeChoice = { kind: 'entity', label: name };
                nodes.push({ id: choiceKey(choice), label: label(name), text: name, kind: 'entity', choice });
            }
        }
        const from = choiceKey({ kind: 'entity', label: edge.source });
        const to = choiceKey({ kind: 'entity', label: edge.target });
        link(from, to, 'relation', edge.relation);
        const article = edge.evidence_url ? articles.get(edge.evidence_url) : undefined;
        if (article !== undefined) {
            link(article, from, 'evidence');
            link(article, to, 'evidence');
        }
    }
    return { nodes, links: [...links.values()] };
}

// The keys of everything below a folded branch, which the graph hides.
export function hiddenKeys(tree: MapNode, folded: Set<string>): Set<string> {
    const hidden = new Set<string>();
    const hide = (node: MapNode): void => {
        for (const child of node.children) {
            hidden.add(child.key);
            hide(child);
        }
    };
    const walk = (node: MapNode): void => {
        if (folded.has(node.key)) {
            hide(node);
        } else {
            node.children.forEach(walk);
        }
    };
    walk(tree);
    return hidden;
}

// ============================================================================
// Drawing
// ============================================================================

export type KnowledgeGraphOptions = { onChoose: (choice: TreeChoice) => void };

function colour(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function stylesheet(): cytoscape.StylesheetJson {
    const foreground = colour('--foreground');
    const muted = colour('--muted');
    const primary = colour('--primary');
    const line = colour('--field-border');
    const surface = colour('--surface');
    return [
        {
            selector: 'node',
            style: {
                label: 'data(label)',
                color: foreground,
                'font-family': getComputedStyle(document.body).fontFamily,
                'font-size': 12,
                'text-valign': 'bottom',
                'text-margin-y': 4,
                'text-wrap': 'wrap',
                'text-max-width': '160px',
                'text-outline-color': surface,
                'text-outline-width': 2,
                'background-color': line,
                width: 12,
                height: 12,
            },
        },
        { selector: 'node[kind = "all"]', style: { 'background-color': primary, width: 28, height: 28, 'font-size': 14, 'font-weight': 'bold' } },
        {
            selector: 'node[kind = "topic"], node[kind = "uncategorized"]',
            style: { 'background-color': primary, 'background-opacity': 0.7, width: 18, height: 18, 'font-weight': 'bold' },
        },
        { selector: 'node[kind = "source"]', style: { shape: 'round-rectangle', color: muted, 'font-size': 11 } },
        { selector: 'node[kind = "fact"]', style: { shape: 'diamond', color: muted, 'font-size': 11, 'font-style': 'italic' } },
        { selector: 'node[kind = "entity"]', style: { shape: 'hexagon', 'background-color': colour('--success'), width: 16, height: 16 } },
        { selector: 'node.folded', style: { 'border-width': 3, 'border-color': primary, 'border-style': 'double' } },
        { selector: 'node:selected', style: { 'border-width': 3, 'border-color': foreground, 'border-style': 'solid' } },
        { selector: 'edge', style: { width: 1.5, 'line-color': line, 'curve-style': 'bezier', opacity: 0.8 } },
        {
            selector: 'edge[kind = "relation"]',
            style: {
                label: 'data(label)',
                'line-color': colour('--success'),
                'target-arrow-color': colour('--success'),
                'target-arrow-shape': 'triangle',
                color: muted,
                'font-size': 10,
                'text-rotation': 'autorotate',
                'text-outline-color': surface,
                'text-outline-width': 2,
            },
        },
        { selector: 'edge[kind = "evidence"]', style: { 'line-style': 'dashed', width: 1, opacity: 0.5 } },
    ];
}

// Keeps a Cytoscape graph of the knowledge store, with branches folded by double-click and the view kept across redraws.
export class KnowledgeGraph {
    private readonly cy: cytoscape.Core;
    private readonly folded = new Set<string>();
    private readonly choices = new Map<string, TreeChoice>();
    private tree: MapNode | null = null;
    private drawnIds = '';

    constructor(
        private readonly container: HTMLElement,
        options: KnowledgeGraphOptions,
    ) {
        this.cy = cytoscape({
            container,
            style: stylesheet(),
            boxSelectionEnabled: false,
            minZoom: 0.1,
            maxZoom: 3,
        });
        this.cy.on('tap', 'node', (event) => {
            const choice = this.choices.get(event.target.id());
            if (choice !== undefined) {
                options.onChoose(choice);
            }
        });
        this.cy.on('dbltap', 'node', (event) => this.toggle(event.target.id()));
        // Labels are shortened, so the full text shows as the pointer's tooltip.
        this.cy.on('mouseover', 'node', (event) => {
            this.container.title = event.target.data('text');
        });
        this.cy.on('mouseout', 'node', () => {
            this.container.title = '';
        });
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.cy.style(stylesheet()));
    }

    draw(tree: MapNode, graph: GraphEdge[], sources: Source[], facts: Fact[], chosenKey: string | null): void {
        this.tree = tree;
        const { nodes, links } = knowledgeElements(tree, graph, sources, facts);
        this.choices.clear();
        for (const node of nodes) {
            this.choices.set(node.id, node.choice);
        }
        const ids = [...nodes.map((node) => node.id), ...links.map((item) => item.id)].join('\n');
        if (ids !== this.drawnIds) {
            this.drawnIds = ids;
            this.cy.elements().remove();
            this.cy.add([
                ...nodes.map((node) => ({ group: 'nodes' as const, data: { id: node.id, label: node.label, text: node.text, kind: node.kind } })),
                ...links.map((item) => ({ group: 'edges' as const, data: { ...item } })),
            ]);
            this.applyFolds(true);
        }
        this.cy.$(':selected').unselect();
        if (chosenKey !== null) {
            this.cy.getElementById(chosenKey).select();
        }
    }

    expandAll(): void {
        this.folded.clear();
        this.applyFolds(true);
    }

    // Folds every branch below the root, leaving only the top-level topics and the things they relate.
    collapseAll(): void {
        for (const branch of this.tree?.children ?? []) {
            if (branch.children.length > 0) {
                this.folded.add(branch.key);
            }
        }
        this.applyFolds(true);
    }

    resetView(): void {
        this.cy.fit(this.cy.elements(':visible'), FIT_PADDING);
        if (this.cy.zoom() > 1) {
            this.cy.zoom(1);
            this.cy.center(this.cy.elements(':visible'));
        }
    }

    private toggle(key: string): void {
        const node = this.findNode(key);
        if (node === null || node.children.length === 0) {
            return;
        }
        if (!this.folded.delete(key)) {
            this.folded.add(key);
        }
        this.applyFolds(false);
    }

    private findNode(key: string): MapNode | null {
        const search = (node: MapNode): MapNode | null => {
            if (node.key === key) {
                return node;
            }
            for (const child of node.children) {
                const found = search(child);
                if (found !== null) {
                    return found;
                }
            }
            return null;
        };
        return this.tree === null ? null : search(this.tree);
    }

    // Hides what folded branches hold, marks the folded nodes, and lays the shown graph out again.
    private applyFolds(fit: boolean): void {
        if (this.tree === null) {
            return;
        }
        const hidden = hiddenKeys(this.tree, this.folded);
        this.cy.batch(() => {
            this.cy.nodes().forEach((node) => {
                node.style('display', hidden.has(node.id()) ? 'none' : 'element');
                node.toggleClass('folded', this.folded.has(node.id()));
            });
        });
        // A thing folds away with the articles that evidence it; one no article mentions always shows.
        this.cy.nodes('[kind = "entity"]').forEach((node) => {
            const articles = node.connectedEdges('[kind = "evidence"]').sources().map((article) => article.id());
            const shown = articles.length === 0 || articles.some((article) => !hidden.has(article));
            node.style('display', shown ? 'element' : 'none');
        });
        // Tree lines pull tightest, relationships less, and evidence lines only loosely.
        const length = { tree: 80, relation: 140, evidence: 180 } as Record<string, number>;
        const elasticity = { tree: 100, relation: 60, evidence: 10 } as Record<string, number>;
        const layout = this.cy.elements(':visible').layout({
            name: 'cose',
            // A fresh drawing starts from scratch; a fold moves the nodes on from where they are.
            randomize: fit,
            animate: !fit,
            animationDuration: 300,
            fit: false,
            nodeDimensionsIncludeLabels: true,
            idealEdgeLength: (edge: cytoscape.EdgeSingular) => length[edge.data('kind')] ?? 100,
            edgeElasticity: (edge: cytoscape.EdgeSingular) => elasticity[edge.data('kind')] ?? 50,
            nodeRepulsion: () => 40000,
            nodeOverlap: 20,
            gravity: 0.4,
            numIter: 2500,
        });
        if (fit) {
            layout.one('layoutstop', () => this.resetView());
        }
        layout.run();
    }
}
