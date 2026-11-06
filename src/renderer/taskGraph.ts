// The workbench's task graph, drawn with force-graph: one row per level of the task tree, a line from each
// task to its subtasks, and dashed arrows to the tasks a task builds on, shown for the chosen or pointed-at task.
import type ForceGraphType from 'force-graph';

import type { TaskNode } from './types.js';
import { TASK_STATE_WORDS } from './taskView.js';

// force-graph loads as its self-contained browser bundle, which sets this global.
declare const ForceGraph: typeof ForceGraphType;

export const BOX_WIDTH = 176;
export const BOX_HEIGHT = 46;
export const BOX_GAP = 22;
export const ROW_GAP = 100;
const FIT_MARGIN = 16;
// Fitting a small tree stops at this zoom rather than filling the panel with it.
const MAX_FIT_ZOOM = 1.2;
const ARROW_LENGTH = 7;
// Each step of the layout spaces the rows this many times, so a crowded row clears within a step.
const ROW_PASSES = 3;

// ============================================================================
// Elements
// ============================================================================

export type TaskGraphNode = { id: string; parent: string | null; depth: number; status: string; prompt: string };

export type TaskGraphLink = { id: string; source: string; target: string; kind: 'subtask' | 'dependency' };

export type TaskGraphElements = { nodes: TaskGraphNode[]; links: TaskGraphLink[] };

function parentId(id: string): string | null {
    const separator = id.lastIndexOf('.');
    return separator < 0 ? null : id.slice(0, separator);
}

// Turns the task list into graph nodes, a line from each task to each of its subtasks,
// and an arrow from each task to every task that builds on it.
export function taskGraphElements(tasks: TaskNode[]): TaskGraphElements {
    const ids = new Set(tasks.map((task) => task.id));
    const nodes = tasks.map((task) => {
        const parent = parentId(task.id);
        return {
            id: task.id,
            parent: parent !== null && ids.has(parent) ? parent : null,
            depth: task.id.split('.').length - 1,
            status: task.status in TASK_STATE_WORDS ? task.status : 'pending',
            prompt: task.prompt.replace(/\s+/g, ' ').trim(),
        };
    });
    const links: TaskGraphLink[] = [];
    for (const node of nodes) {
        if (node.parent !== null) {
            links.push({ id: `subtask:${node.parent}>${node.id}`, source: node.parent, target: node.id, kind: 'subtask' });
        }
    }
    for (const task of tasks) {
        for (const dependency of task.depends_on ?? []) {
            if (ids.has(dependency)) {
                links.push({ id: `dependency:${dependency}>${task.id}`, source: dependency, target: task.id, kind: 'dependency' });
            }
        }
    }
    return { nodes, links };
}

type LinkEnd = string | { id: string };

function endId(end: LinkEnd): string {
    return typeof end === 'string' ? end : end.id;
}

// Whether a link shows: subtask lines always, dependency arrows only when they touch a task in focus.
export function linkShown(link: { kind: string; source: LinkEnd; target: LinkEnd }, focusIds: (string | null)[]): boolean {
    return link.kind === 'subtask' || focusIds.includes(endId(link.source)) || focusIds.includes(endId(link.target));
}

// ============================================================================
// Layout
// ============================================================================

export type Placed = { id: string; x?: number; fy?: number };

// Orders task numbers as the tree reads, so 1.2.3 comes before 1.3.1 and 1.10 after 1.9.
export function treeOrder(first: string, second: string): number {
    const firstParts = first.split('.').map(Number);
    const secondParts = second.split('.').map(Number);
    for (let index = 0; index < Math.min(firstParts.length, secondParts.length); index++) {
        if (firstParts[index] !== secondParts[index]) {
            return firstParts[index] - secondParts[index];
        }
    }
    return firstParts.length - secondParts.length;
}

// Pushes apart neighbours in the same row that sit closer than a box and a gap, keeping each row in tree order.
export function separateRows(nodes: Placed[]): void {
    const rows = new Map<number, Placed[]>();
    for (const node of nodes) {
        const row = rows.get(node.fy ?? 0) ?? [];
        row.push(node);
        rows.set(node.fy ?? 0, row);
    }
    for (const row of rows.values()) {
        row.sort((first, second) => treeOrder(first.id, second.id));
        for (let index = 1; index < row.length; index++) {
            const left = row[index - 1];
            const right = row[index];
            const overlap = BOX_WIDTH + BOX_GAP - ((right.x ?? 0) - (left.x ?? 0));
            if (overlap > 0) {
                left.x = (left.x ?? 0) - overlap / 2;
                right.x = (right.x ?? 0) + overlap / 2;
            }
        }
    }
}

// Where a new task starts: under its parent, spread out in task order among its siblings.
export function startingX(parentX: number, siblingIndex: number, siblingCount: number): number {
    return parentX + (siblingIndex - (siblingCount - 1) / 2) * (BOX_WIDTH + BOX_GAP);
}

// ============================================================================
// Drawing
// ============================================================================

export type TaskGraphOptions = { onChoose: (taskId: string) => void };

// The simulation's copies: force-graph adds positions to nodes and swaps link ends for the node objects.
type SimNode = TaskGraphNode & { x?: number; y?: number; vx?: number; vy?: number; fy?: number };
type SimLink = Omit<TaskGraphLink, 'source' | 'target'> & { source: string | SimNode; target: string | SimNode };

type Palette = { foreground: string; label: string; border: string; line: string; surface: string; dependency: string; font: string; states: Record<string, string> };

function palette(): Palette {
    const style = getComputedStyle(document.documentElement);
    const colour = (name: string): string => style.getPropertyValue(name).trim();
    return {
        foreground: colour('--foreground'),
        label: colour('--label'),
        border: colour('--border'),
        line: colour('--field-border'),
        surface: colour('--surface'),
        dependency: colour('--primary'),
        font: getComputedStyle(document.body).fontFamily,
        states: {
            pending: colour('--muted'),
            running: colour('--primary'),
            done: colour('--success'),
            unverified: colour('--warning'),
            failed: colour('--error'),
        },
    };
}

// Shortens text with an ellipsis until it fits the given width.
function fitted(context: CanvasRenderingContext2D, text: string, width: number): string {
    if (context.measureText(text).width <= width) {
        return text;
    }
    let length = text.length;
    while (length > 0 && context.measureText(`${text.slice(0, length)}…`).width > width) {
        length--;
    }
    return `${text.slice(0, length)}…`;
}

// Keeps a live graph of the run's tasks: it follows the panel's size, adds new tasks under their parent,
// and recolours tasks in place as their state changes.
export class TaskGraph {
    private readonly graph: ForceGraphType<SimNode, SimLink>;
    private colours = palette();
    private simNodes = new Map<string, SimNode>();
    private chosenId: string | null = null;
    private pointedId: string | null = null;
    private drawnIds = '';
    private fitPending = true;

    constructor(
        private readonly container: HTMLElement,
        private readonly options: TaskGraphOptions,
    ) {
        this.graph = new ForceGraph<SimNode, SimLink>(container)
            .nodeId('id')
            .warmupTicks(100)
            .cooldownTime(2000)
            .nodeLabel(() => '')
            .nodeCanvasObject((node, context) => this.drawNode(node, context))
            .nodePointerAreaPaint((node, colour, context) => {
                context.fillStyle = colour;
                context.fillRect((node.x ?? 0) - BOX_WIDTH / 2, (node.y ?? 0) - BOX_HEIGHT / 2, BOX_WIDTH, BOX_HEIGHT);
            })
            .linkVisibility((link) => linkShown(link, [this.chosenId, this.pointedId]))
            .linkColor(() => this.colours.line)
            .linkWidth(1.4)
            .linkCanvasObjectMode((link) => (link.kind === 'dependency' ? 'replace' : undefined))
            .linkCanvasObject((link, context) => this.drawDependency(link, context))
            .onNodeClick((node) => this.options.onChoose(node.id))
            .onNodeHover((node) => {
                // Prompts are shortened in the boxes, so the full prompt shows as the pointer's tooltip.
                this.container.title = node?.prompt ?? '';
                this.pointedId = node?.id ?? null;
                this.repaint();
            })
            .onEngineStop(() => {
                if (this.fitPending) {
                    this.fitPending = false;
                    this.resetView();
                }
            });
        // Rows are fixed by depth, so only subtask lines pull sideways and boxes in a row keep apart.
        this.graph.d3Force('charge', null);
        const links = this.graph.d3Force('link') as unknown as
            | { distance(length: number): { strength(strength: (link: SimLink) => number): void } }
            | undefined;
        links?.distance(ROW_GAP).strength((link) => (link.kind === 'subtask' ? 0.6 : 0));
        const rows = Object.assign(
            () => {
                for (let pass = 0; pass < ROW_PASSES; pass++) {
                    separateRows([...this.simNodes.values()]);
                }
            },
            { initialize: () => undefined },
        );
        this.graph.d3Force('rows', rows as never);
        new ResizeObserver(() => {
            if (container.clientWidth > 0 && container.clientHeight > 0) {
                this.graph.width(container.clientWidth).height(container.clientHeight);
                this.resetView();
            }
        }).observe(container);
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            this.colours = palette();
            this.repaint();
        });
    }

    draw(tasks: TaskNode[], chosenId: string | null): void {
        this.chosenId = chosenId;
        const elements = taskGraphElements(tasks);
        const ids = [...elements.nodes.map((node) => node.id), ...elements.links.map((link) => link.id)].join('\n');
        if (ids === this.drawnIds) {
            for (const node of elements.nodes) {
                Object.assign(this.simNodes.get(node.id) ?? {}, { status: node.status, prompt: node.prompt });
            }
            this.repaint();
            return;
        }
        this.drawnIds = ids;
        this.fitPending = true;
        this.place(elements);
    }

    // Fits every box, not just the box centres, inside the panel.
    resetView(): void {
        const placed = [...this.simNodes.values()].filter((node) => Number.isFinite(node.x) && Number.isFinite(node.y));
        if (placed.length === 0 || this.container.clientWidth === 0) {
            return;
        }
        const xs = placed.map((node) => node.x as number);
        const ys = placed.map((node) => node.y as number);
        const width = Math.max(...xs) - Math.min(...xs) + BOX_WIDTH + FIT_MARGIN * 2;
        const height = Math.max(...ys) - Math.min(...ys) + BOX_HEIGHT + FIT_MARGIN * 2;
        this.graph.centerAt((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2);
        this.graph.zoom(Math.min(MAX_FIT_ZOOM, this.container.clientWidth / width, this.container.clientHeight / height));
    }

    // Hands the simulation the tasks, keeping each old task where it was and starting new ones under their parent.
    private place(elements: TaskGraphElements): void {
        const previous = this.simNodes;
        this.simNodes = new Map();
        for (const node of [...elements.nodes].sort((first, second) => first.depth - second.depth)) {
            const old = previous.get(node.id);
            const siblings = elements.nodes.filter((other) => other.parent === node.parent);
            const parentX = node.parent === null ? 0 : (this.simNodes.get(node.parent)?.x ?? 0);
            const x = old?.x ?? startingX(parentX, siblings.indexOf(node), siblings.length);
            this.simNodes.set(node.id, { ...node, x, y: old?.y, vx: old?.vx, vy: old?.vy, fy: node.depth * ROW_GAP });
        }
        this.graph.graphData({
            nodes: elements.nodes.map((node) => this.simNodes.get(node.id) as SimNode),
            links: elements.links.map((link) => ({ ...link })),
        });
    }

    // Setting any drawing option makes force-graph draw the next frame, even once the layout has settled.
    private repaint(): void {
        this.graph.linkVisibility(this.graph.linkVisibility());
    }

    // Draws a dashed arc over the row from the top of one box to the top of the task that builds on it.
    private drawDependency(link: SimLink, context: CanvasRenderingContext2D): void {
        const start = link.source;
        const end = link.target;
        if (typeof start === 'string' || typeof end === 'string') {
            return;
        }
        const startX = start.x ?? 0;
        const endX = end.x ?? 0;
        const top = (start.y ?? 0) - BOX_HEIGHT / 2;
        const lift = Math.min(ROW_GAP / 2, 12 + Math.abs(endX - startX) / 6);
        context.beginPath();
        context.moveTo(startX, top);
        context.quadraticCurveTo((startX + endX) / 2, top - lift * 2, endX, top - ARROW_LENGTH / 2);
        context.setLineDash([4, 3]);
        context.lineWidth = 1.2;
        context.strokeStyle = this.colours.dependency;
        context.stroke();
        context.setLineDash([]);
        const angle = Math.atan2(lift * 2 - ARROW_LENGTH / 2, endX - (startX + endX) / 2);
        context.beginPath();
        context.moveTo(endX, top);
        context.lineTo(endX - ARROW_LENGTH * Math.cos(angle - 0.4), top - ARROW_LENGTH * Math.sin(angle - 0.4));
        context.lineTo(endX - ARROW_LENGTH * Math.cos(angle + 0.4), top - ARROW_LENGTH * Math.sin(angle + 0.4));
        context.closePath();
        context.fillStyle = this.colours.dependency;
        context.fill();
    }

    private drawNode(node: SimNode, context: CanvasRenderingContext2D): void {
        const colours = this.colours;
        const state = colours.states[node.status] ?? colours.states.pending;
        const left = (node.x ?? 0) - BOX_WIDTH / 2;
        const top = (node.y ?? 0) - BOX_HEIGHT / 2;
        const chosen = node.id === this.chosenId;
        context.beginPath();
        context.roundRect(left, top, BOX_WIDTH, BOX_HEIGHT, 7);
        context.fillStyle = colours.surface;
        context.fill();
        context.lineWidth = chosen ? 2 : 1;
        context.strokeStyle = chosen ? colours.dependency : colours.border;
        context.stroke();
        context.beginPath();
        context.roundRect(left, top, 5, BOX_HEIGHT, 2);
        context.fillStyle = state;
        context.fill();

        context.textAlign = 'left';
        context.textBaseline = 'alphabetic';
        context.font = `600 12px ${colours.font}`;
        context.fillStyle = colours.foreground;
        context.fillText(node.id, left + 13, top + 18);
        const idWidth = context.measureText(node.id).width;
        context.font = `600 10px ${colours.font}`;
        context.fillStyle = state;
        context.fillText((TASK_STATE_WORDS[node.status] ?? 'WAIT').trim(), left + 21 + idWidth, top + 18);
        context.font = `11px ${colours.font}`;
        context.fillStyle = colours.label;
        context.fillText(fitted(context, node.prompt, BOX_WIDTH - 22), left + 13, top + 35);
    }
}
