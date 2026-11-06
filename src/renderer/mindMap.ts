// The knowledge page's mind map: the root in the middle, its branches split to both sides, drawn as SVG with pan, zoom and folding.
import type { MapNode, TreeChoice } from './knowledgeView.js';

export const NODE_HEIGHT = 26;
export const ROW_GAP = 8;
export const LEVEL_GAP = 48;
export const NODE_PADDING = 10;
export const TOGGLE_RADIUS = 7;
export const MAX_LABEL_CHARS = 48;
const MIN_SCALE = 0.2;
const MAX_SCALE = 3;
const FIT_MARGIN = 24;
const SVG = 'http://www.w3.org/2000/svg';

// ============================================================================
// Layout
// ============================================================================

// Which way a node grows from the root: 1 to the right, -1 to the left, 0 for the root itself.
export type Side = -1 | 0 | 1;

export type PlacedNode = {
    node: MapNode;
    label: string;
    depth: number;
    side: Side;
    // The box's left edge and vertical centre, with the root centred on 0, 0.
    x: number;
    y: number;
    width: number;
    folded: boolean;
};

export type MapLink = { from: PlacedNode; to: PlacedNode };

export type MapLayout = { nodes: PlacedNode[]; links: MapLink[] };

export function label(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_LABEL_CHARS ? `${flat.slice(0, MAX_LABEL_CHARS - 1)}…` : flat;
}

function shown(node: MapNode, folded: Set<string>): MapNode[] {
    return folded.has(node.key) ? [] : node.children;
}

function stackedHeight(nodes: MapNode[], folded: Set<string>): number {
    return nodes.reduce((total, node) => total + blockHeight(node, folded), 0) + ROW_GAP * Math.max(0, nodes.length - 1);
}

function blockHeight(node: MapNode, folded: Set<string>): number {
    return Math.max(NODE_HEIGHT, stackedHeight(shown(node, folded), folded));
}

// Gives the root's first branches to the right until it holds about half the height, and the rest to the left.
// Heights count every branch unfolded, so folding one never moves a branch to the other side.
function splitSides(branches: MapNode[]): [MapNode[], MapNode[]] {
    const heights = branches.map((branch) => blockHeight(branch, new Set()));
    const total = heights.reduce((sum, height) => sum + height, 0);
    const right: MapNode[] = [];
    const left: MapNode[] = [];
    let rightHeight = 0;
    branches.forEach((branch, index) => {
        if (right.length === 0 || rightHeight + heights[index] / 2 <= total / 2) {
            right.push(branch);
            rightHeight += heights[index];
        } else {
            left.push(branch);
        }
    });
    return [right, left];
}

// Places each shown node in columns by depth on its side, each parent centred on the block of its children.
export function layoutMindMap(root: MapNode, folded: Set<string>, measure: (text: string, node: MapNode) => number): MapLayout {
    const box = (node: MapNode, depth: number, side: Side): PlacedNode => {
        const text = label(node.text);
        return {
            node,
            label: text,
            depth,
            side,
            x: 0,
            y: 0,
            width: Math.ceil(measure(text, node)) + NODE_PADDING * 2,
            folded: folded.has(node.key) && node.children.length > 0,
        };
    };
    const rootBox = box(root, 0, 0);
    rootBox.x = -rootBox.width / 2;
    const nodes: PlacedNode[] = [rootBox];
    const links: MapLink[] = [];

    const placeSide = (branches: MapNode[], side: Side): void => {
        const placed: PlacedNode[] = [];
        const place = (node: MapNode, parent: PlacedNode, depth: number, top: number): void => {
            const placedNode = box(node, depth, side);
            const height = blockHeight(node, folded);
            placedNode.y = top + height / 2;
            placed.push(placedNode);
            links.push({ from: parent, to: placedNode });
            const children = shown(node, folded);
            let childTop = top + (height - stackedHeight(children, folded)) / 2;
            for (const child of children) {
                place(child, placedNode, depth + 1, childTop);
                childTop += blockHeight(child, folded) + ROW_GAP;
            }
        };
        let top = -stackedHeight(branches, folded) / 2;
        for (const branch of branches) {
            place(branch, rootBox, 1, top);
            top += blockHeight(branch, folded) + ROW_GAP;
        }
        // Every column is as wide as its widest node; nodes line up on the edge nearer the root.
        const widths: number[] = [];
        for (const node of placed) {
            widths[node.depth] = Math.max(widths[node.depth] ?? 0, node.width);
        }
        const starts: number[] = [];
        let edge = rootBox.width / 2 + LEVEL_GAP;
        for (let depth = 1; depth < widths.length; depth++) {
            starts[depth] = edge;
            edge += widths[depth] + LEVEL_GAP;
        }
        for (const node of placed) {
            node.x = side === 1 ? starts[node.depth] : -starts[node.depth] - node.width;
        }
        nodes.push(...placed);
    };

    const [right, left] = splitSides(root.children);
    placeSide(right, 1);
    placeSide(left, -1);
    return { nodes, links };
}

// A curve from the parent's outer edge, past its fold button, to the child's inner edge.
export function linkPath(link: MapLink): string {
    const { from, to } = link;
    const toggle = from.side === 0 ? 0 : TOGGLE_RADIUS * 2 + 2;
    const startX = to.side === 1 ? from.x + from.width + toggle : from.x - toggle;
    const endX = to.side === 1 ? to.x : to.x + to.width;
    const middle = (startX + endX) / 2;
    return `M ${startX} ${from.y} C ${middle} ${from.y}, ${middle} ${to.y}, ${endX} ${to.y}`;
}

// ============================================================================
// Drawing
// ============================================================================

export type MindMapOptions = {
    onChoose: (choice: TreeChoice) => void;
};

type View = { x: number; y: number; scale: number };

// Draws a knowledge tree into an SVG element and keeps its folding, pan and zoom across redraws.
export class MindMap {
    private readonly scene: SVGGElement;
    private readonly folded = new Set<string>();
    private readonly context = document.createElement('canvas').getContext('2d');
    private root: MapNode | null = null;
    private chosenKey: string | null = null;
    private view: View | null = null;

    constructor(
        private readonly svg: SVGSVGElement,
        private readonly options: MindMapOptions,
    ) {
        this.scene = document.createElementNS(SVG, 'g');
        this.svg.append(this.scene);
        this.listen();
    }

    draw(root: MapNode, chosenKey: string | null): void {
        this.root = root;
        this.chosenKey = chosenKey;
        this.redraw();
    }

    expandAll(): void {
        this.folded.clear();
        this.view = null;
        this.redraw();
    }

    // Folds every branch below the root, leaving only the top-level topics.
    collapseAll(): void {
        const fold = (node: MapNode): void => {
            for (const child of node.children) {
                if (child.children.length > 0) {
                    this.folded.add(child.key);
                    fold(child);
                }
            }
        };
        if (this.root !== null) {
            fold(this.root);
        }
        this.view = null;
        this.redraw();
    }

    // Fits the whole map in the panel again, at no more than full size.
    resetView(): void {
        this.view = null;
        this.applyView();
    }

    private redraw(): void {
        if (this.root === null) {
            return;
        }
        const layout = layoutMindMap(this.root, this.folded, (text, node) => this.measure(text, node));
        this.scene.textContent = '';
        for (const link of layout.links) {
            const path = document.createElementNS(SVG, 'path');
            path.setAttribute('class', 'map-link');
            path.setAttribute('d', linkPath(link));
            this.scene.append(path);
        }
        for (const placed of layout.nodes) {
            this.scene.append(this.nodeElement(placed));
        }
        this.applyView();
    }

    private nodeElement(placed: PlacedNode): SVGGElement {
        const { node } = placed;
        const group = document.createElementNS(SVG, 'g');
        group.setAttribute('class', 'map-node');
        group.dataset.kind = node.choice.kind;
        group.dataset.key = node.key;
        group.setAttribute('role', 'treeitem');
        group.setAttribute('tabindex', '0');
        group.setAttribute('aria-selected', String(node.key === this.chosenKey));
        if (node.children.length > 0) {
            group.setAttribute('aria-expanded', String(!placed.folded));
        }
        const title = document.createElementNS(SVG, 'title');
        title.textContent = node.text;
        const rect = document.createElementNS(SVG, 'rect');
        rect.setAttribute('x', String(placed.x));
        rect.setAttribute('y', String(placed.y - NODE_HEIGHT / 2));
        rect.setAttribute('width', String(placed.width));
        rect.setAttribute('height', String(NODE_HEIGHT));
        rect.setAttribute('rx', '6');
        const text = document.createElementNS(SVG, 'text');
        text.setAttribute('x', String(placed.x + NODE_PADDING));
        text.setAttribute('y', String(placed.y));
        text.setAttribute('dominant-baseline', 'central');
        text.textContent = placed.label;
        group.append(title, rect, text);
        group.addEventListener('click', () => this.options.onChoose(node.choice));
        group.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.options.onChoose(node.choice);
            } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && node.children.length > 0) {
                this.toggle(node.key);
                this.scene.querySelector<SVGGElement>(`.map-node[data-key="${CSS.escape(node.key)}"]`)?.focus();
            }
        });
        if (node.children.length > 0 && placed.side !== 0) {
            group.append(this.toggleElement(placed));
        }
        return group;
    }

    // The fold button on a branch's outer edge: a minus when open, a plus with the hidden count when folded.
    private toggleElement(placed: PlacedNode): SVGGElement {
        const centreX = placed.side === 1 ? placed.x + placed.width + TOGGLE_RADIUS + 2 : placed.x - TOGGLE_RADIUS - 2;
        const toggle = document.createElementNS(SVG, 'g');
        toggle.setAttribute('class', 'map-toggle');
        const circle = document.createElementNS(SVG, 'circle');
        circle.setAttribute('cx', String(centreX));
        circle.setAttribute('cy', String(placed.y));
        circle.setAttribute('r', String(TOGGLE_RADIUS));
        const sign = document.createElementNS(SVG, 'text');
        sign.setAttribute('x', String(centreX));
        sign.setAttribute('y', String(placed.y));
        sign.setAttribute('text-anchor', 'middle');
        sign.setAttribute('dominant-baseline', 'central');
        sign.textContent = placed.folded ? '+' : '−';
        const title = document.createElementNS(SVG, 'title');
        title.textContent = placed.folded ? `Show ${placed.node.children.length} hidden` : 'Fold';
        toggle.append(title, circle, sign);
        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            this.toggle(placed.node.key);
        });
        return toggle;
    }

    private toggle(key: string): void {
        if (!this.folded.delete(key)) {
            this.folded.add(key);
        }
        this.redraw();
    }

    private measure(text: string, node: MapNode): number {
        if (this.context === null) {
            return text.length * 7;
        }
        const style = getComputedStyle(this.svg);
        const weight = node.choice.kind === 'source' || node.choice.kind === 'fact' ? '400' : '600';
        const size = node.choice.kind === 'all' ? '14px' : node.choice.kind === 'source' || node.choice.kind === 'fact' ? '12px' : '13px';
        this.context.font = `${weight} ${size} ${style.fontFamily}`;
        return this.context.measureText(text).width;
    }

    private applyView(): void {
        if (this.view === null) {
            // A hidden page has no size yet; the map is fitted when it is next drawn on screen.
            const bounds = this.svg.getBoundingClientRect();
            if (bounds.width === 0) {
                return;
            }
            const content = this.scene.getBBox();
            const scale = Math.max(
                MIN_SCALE,
                Math.min(1, (bounds.width - FIT_MARGIN * 2) / content.width, (bounds.height - FIT_MARGIN * 2) / content.height),
            );
            this.view = {
                x: bounds.width / 2 - (content.x + content.width / 2) * scale,
                y: bounds.height / 2 - (content.y + content.height / 2) * scale,
                scale,
            };
        }
        this.scene.setAttribute('transform', `translate(${this.view.x} ${this.view.y}) scale(${this.view.scale})`);
    }

    // Dragging the background pans; the wheel zooms around the pointer.
    private listen(): void {
        let drag: { pointer: number; startX: number; startY: number; viewX: number; viewY: number } | null = null;
        this.svg.addEventListener('pointerdown', (event) => {
            if (this.view === null || (event.target as Element).closest('.map-node')) {
                return;
            }
            drag = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, viewX: this.view.x, viewY: this.view.y };
            this.svg.setPointerCapture(event.pointerId);
            this.svg.classList.add('panning');
        });
        this.svg.addEventListener('pointermove', (event) => {
            if (drag === null || this.view === null || event.pointerId !== drag.pointer) {
                return;
            }
            this.view.x = drag.viewX + event.clientX - drag.startX;
            this.view.y = drag.viewY + event.clientY - drag.startY;
            this.applyView();
        });
        const stop = (): void => {
            drag = null;
            this.svg.classList.remove('panning');
        };
        this.svg.addEventListener('pointerup', stop);
        this.svg.addEventListener('pointercancel', stop);
        this.svg.addEventListener(
            'wheel',
            (event) => {
                if (this.view === null) {
                    return;
                }
                event.preventDefault();
                const bounds = this.svg.getBoundingClientRect();
                const pointerX = event.clientX - bounds.left;
                const pointerY = event.clientY - bounds.top;
                const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.view.scale * Math.exp(-event.deltaY / 500)));
                const ratio = scale / this.view.scale;
                this.view = { x: pointerX - (pointerX - this.view.x) * ratio, y: pointerY - (pointerY - this.view.y) * ratio, scale };
                this.applyView();
            },
            { passive: false },
        );
    }
}
