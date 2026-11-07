// The workbench's task graph, drawn with force-graph: one row per level of the task tree with each task's steps
// in a chain beneath it, a line from the step that planned subtasks to each subtask, and dashed arrows to the
// tasks a task builds on, shown for the chosen or pointed-at task.
import type ForceGraphType from 'force-graph';

import type { StepRecord, TaskNode } from './types.js';
import { TASK_STATE_WORDS } from './taskView.js';

// force-graph loads as its self-contained browser bundle, which sets this global.
declare const ForceGraph: typeof ForceGraphType;

export const BOX_WIDTH = 176;
export const BOX_HEIGHT = 46;
export const STEP_WIDTH = 104;
export const STEP_HEIGHT = 26;
export const BOX_GAP = 22;
export const STEP_GAP = 18;
export const ROW_GAP = 150;
// A task's steps sit this far below the task, above the next level of tasks.
export const STEP_ROW_OFFSET = 62;
// Subtasks hang from the last step with this name, the one that planned them.
export const PLANNING_STEP = 'Planning subtasks';
const FIT_MARGIN = 16;
// Fitting a small tree stops at this zoom rather than filling the panel with it.
const MAX_FIT_ZOOM = 1.2;
const ARROW_LENGTH = 7;
// Each step of the layout spaces the rows this many times, so a crowded row clears within a step.
const ROW_PASSES = 3;

// ============================================================================
// Elements
// ============================================================================

export type TaskGraphNode = {
    id: string;
    kind: 'task' | 'step';
    taskId: string;
    // The node a new node starts under: a task's parent task, or a step's own task.
    anchor: string | null;
    depth: number;
    row: number;
    status: string;
    label: string;
    // The full text shown when the pointer rests on the node.
    tooltip: string;
    width: number;
    height: number;
    // For a step node, which step it is: its name and how many steps of that name came before it in the task.
    step: StepTarget | null;
};

export type StepTarget = { name: string; occurrence: number };

export type TaskGraphLink = { id: string; source: string; target: string; kind: 'subtask' | 'dependency' | 'step' };

export type TaskGraphElements = { nodes: TaskGraphNode[]; links: TaskGraphLink[] };

function parentId(id: string): string | null {
    const separator = id.lastIndexOf('.');
    return separator < 0 ? null : id.slice(0, separator);
}

export function stepId(taskId: string, index: number): string {
    return `${taskId}:${index}`;
}

function seconds(step: StepRecord): string {
    return step.ended_at === null ? '' : `, ${Math.max(0, step.ended_at - step.started_at).toFixed(1)} s`;
}

function stepTooltip(step: StepRecord): string {
    return `${step.name} (${step.status}${seconds(step)})${step.error ? `: ${step.error}` : ''}`;
}

// Turns the task list into graph nodes: each task, then its steps in a chain below it, a line to each subtask
// from the step that planned it, and an arrow from each task to every task that builds on it.
export function taskGraphElements(tasks: TaskNode[]): TaskGraphElements {
    const ids = new Set(tasks.map((task) => task.id));
    const nodes: TaskGraphNode[] = [];
    const links: TaskGraphLink[] = [];
    for (const task of tasks) {
        const parent = parentId(task.id);
        const depth = task.id.split('.').length - 1;
        const prompt = task.prompt.replace(/\s+/g, ' ').trim();
        nodes.push({
            id: task.id,
            kind: 'task',
            taskId: task.id,
            anchor: parent !== null && ids.has(parent) ? parent : null,
            depth,
            row: depth * ROW_GAP,
            status: task.status in TASK_STATE_WORDS ? task.status : 'pending',
            label: task.id,
            tooltip: prompt,
            width: BOX_WIDTH,
            height: BOX_HEIGHT,
            step: null,
        });
        (task.steps ?? []).forEach((step, index) => {
            const id = stepId(task.id, index);
            nodes.push({
                id,
                kind: 'step',
                taskId: task.id,
                anchor: task.id,
                depth,
                row: depth * ROW_GAP + STEP_ROW_OFFSET,
                status: step.status,
                label: step.name,
                tooltip: stepTooltip(step),
                width: STEP_WIDTH,
                height: STEP_HEIGHT,
                step: { name: step.name, occurrence: (task.steps ?? []).slice(0, index).filter((earlier) => earlier.name === step.name).length },
            });
            const previous = index === 0 ? task.id : stepId(task.id, index - 1);
            links.push({ id: `step:${previous}>${id}`, source: previous, target: id, kind: 'step' });
        });
    }
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const task of tasks) {
        const parent = parentId(task.id);
        if (parent === null || !ids.has(parent)) {
            continue;
        }
        const planning = (byId.get(parent)!.steps ?? []).map((step) => step.name).lastIndexOf(PLANNING_STEP);
        const source = planning < 0 ? parent : stepId(parent, planning);
        links.push({ id: `subtask:${source}>${task.id}`, source, target: task.id, kind: 'subtask' });
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

// Whether a link shows: subtask and step lines always, dependency arrows only when they touch a task in focus.
export function linkShown(link: { kind: string; source: LinkEnd; target: LinkEnd }, focusIds: (string | null)[]): boolean {
    return link.kind !== 'dependency' || focusIds.includes(endId(link.source)) || focusIds.includes(endId(link.target));
}

// ============================================================================
// Layout
// ============================================================================

export type Placed = { id: string; width?: number; x?: number; fy?: number };

// Orders tasks and steps as the tree reads, so 1.2.3 comes before 1.3.1, 1.10 after 1.9, and step 1:2 after 1:1.
export function treeOrder(first: string, second: string): number {
    const firstParts = first.split(/[.:]/).map(Number);
    const secondParts = second.split(/[.:]/).map(Number);
    for (let index = 0; index < Math.min(firstParts.length, secondParts.length); index++) {
        if (firstParts[index] !== secondParts[index]) {
            return firstParts[index] - secondParts[index];
        }
    }
    return firstParts.length - secondParts.length;
}

// Pushes apart neighbours in the same row that sit closer than their boxes and a gap, keeping each row in tree order.
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
            const reach = ((left.width ?? BOX_WIDTH) + (right.width ?? BOX_WIDTH)) / 2;
            const overlap = reach + BOX_GAP - ((right.x ?? 0) - (left.x ?? 0));
            if (overlap > 0) {
                left.x = (left.x ?? 0) - overlap / 2;
                right.x = (right.x ?? 0) + overlap / 2;
            }
        }
    }
}

// Where a new node starts: under its anchor, spread out in order among the nodes that share it.
export function startingX(anchorX: number, siblingIndex: number, siblingCount: number, width = BOX_WIDTH): number {
    return anchorX + (siblingIndex - (siblingCount - 1) / 2) * (width + BOX_GAP);
}

// ============================================================================
// Drawing
// ============================================================================

export type TaskGraphOptions = { onChoose: (taskId: string, step: StepTarget | null) => void };

// The simulation's copies: force-graph adds positions to nodes and swaps link ends for the node objects.
type SimNode = TaskGraphNode & { x?: number; y?: number; vx?: number; vy?: number; fy?: number };
type SimLink = Omit<TaskGraphLink, 'source' | 'target'> & { source: string | SimNode; target: string | SimNode };

type Palette = {
    foreground: string;
    label: string;
    border: string;
    line: string;
    surface: string;
    stepSurface: string;
    dependency: string;
    font: string;
    states: Record<string, string>;
};

function palette(): Palette {
    const style = getComputedStyle(document.documentElement);
    const colour = (name: string): string => style.getPropertyValue(name).trim();
    return {
        foreground: colour('--foreground'),
        label: colour('--label'),
        border: colour('--border'),
        line: colour('--field-border'),
        surface: colour('--surface'),
        stepSurface: colour('--surface-alt'),
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

function arrowHead(context: CanvasRenderingContext2D, tipX: number, tipY: number, angle: number): void {
    context.beginPath();
    context.moveTo(tipX, tipY);
    context.lineTo(tipX - ARROW_LENGTH * Math.cos(angle - 0.4), tipY - ARROW_LENGTH * Math.sin(angle - 0.4));
    context.lineTo(tipX - ARROW_LENGTH * Math.cos(angle + 0.4), tipY - ARROW_LENGTH * Math.sin(angle + 0.4));
    context.closePath();
    context.fill();
}

// Keeps a live graph of the run's tasks and their steps: it follows the panel's size, adds new tasks and steps
// under the node they belong to, and recolours them in place as their state changes.
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
            .nodeCanvasObject((node, context) => (node.kind === 'task' ? this.drawTask(node, context) : this.drawStep(node, context)))
            .nodePointerAreaPaint((node, colour, context) => {
                context.fillStyle = colour;
                context.fillRect((node.x ?? 0) - node.width / 2, (node.y ?? 0) - node.height / 2, node.width, node.height);
            })
            .linkVisibility((link) => linkShown(link, [this.chosenId, this.pointedId]))
            .linkColor(() => this.colours.line)
            .linkWidth(1.4)
            .linkCanvasObjectMode((link) => (link.kind === 'subtask' ? undefined : 'replace'))
            .linkCanvasObject((link, context) => (link.kind === 'step' ? this.drawStepLink(link, context) : this.drawDependency(link, context)))
            .onNodeClick((node) => this.options.onChoose(node.taskId, node.step))
            .onNodeHover((node) => {
                // Labels are shortened in the boxes, so the full text shows as the pointer's tooltip.
                this.container.title = node?.tooltip ?? '';
                this.pointedId = node?.taskId ?? null;
                this.repaint();
            })
            .onEngineStop(() => {
                if (this.fitPending) {
                    this.fitPending = false;
                    this.resetView();
                }
            });
        // Rows are fixed, so only the lines pull sideways and boxes in a row keep apart.
        this.graph.d3Force('charge', null);
        const links = this.graph.d3Force('link') as unknown as
            | { distance(length: number): { strength(strength: (link: SimLink) => number): void } }
            | undefined;
        links?.distance(ROW_GAP).strength((link) => (link.kind === 'subtask' ? 0.6 : link.kind === 'step' ? 0.3 : 0));
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
                Object.assign(this.simNodes.get(node.id) ?? {}, { status: node.status, tooltip: node.tooltip });
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
        const left = Math.min(...placed.map((node) => (node.x as number) - node.width / 2));
        const right = Math.max(...placed.map((node) => (node.x as number) + node.width / 2));
        const top = Math.min(...placed.map((node) => (node.y as number) - node.height / 2));
        const bottom = Math.max(...placed.map((node) => (node.y as number) + node.height / 2));
        this.graph.centerAt((left + right) / 2, (top + bottom) / 2);
        const zoom = Math.min(
            MAX_FIT_ZOOM,
            this.container.clientWidth / (right - left + FIT_MARGIN * 2),
            this.container.clientHeight / (bottom - top + FIT_MARGIN * 2),
        );
        this.graph.zoom(zoom);
    }

    // Hands the simulation the nodes, keeping each old one where it was and starting new ones under their anchor.
    private place(elements: TaskGraphElements): void {
        const previous = this.simNodes;
        this.simNodes = new Map();
        const byRow = [...elements.nodes].sort((first, second) => first.row - second.row);
        for (const node of byRow) {
            const old = previous.get(node.id);
            const siblings = elements.nodes.filter((other) => other.anchor === node.anchor && other.kind === node.kind);
            const anchorX = node.anchor === null ? 0 : (this.simNodes.get(node.anchor)?.x ?? 0);
            const x = old?.x ?? startingX(anchorX, siblings.indexOf(node), siblings.length, node.width);
            this.simNodes.set(node.id, { ...node, x, y: old?.y, vx: old?.vx, vy: old?.vy, fy: node.row });
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
        const lift = Math.min(ROW_GAP / 3, 12 + Math.abs(endX - startX) / 6);
        context.beginPath();
        context.moveTo(startX, top);
        context.quadraticCurveTo((startX + endX) / 2, top - lift * 2, endX, top - ARROW_LENGTH / 2);
        context.setLineDash([4, 3]);
        context.lineWidth = 1.2;
        context.strokeStyle = this.colours.dependency;
        context.stroke();
        context.setLineDash([]);
        context.fillStyle = this.colours.dependency;
        arrowHead(context, endX, top, Math.atan2(lift * 2 - ARROW_LENGTH / 2, endX - (startX + endX) / 2));
    }

    // Draws a line from a task down to its first step, and an arrow from each step to the next.
    private drawStepLink(link: SimLink, context: CanvasRenderingContext2D): void {
        const start = link.source;
        const end = link.target;
        if (typeof start === 'string' || typeof end === 'string') {
            return;
        }
        const fromTask = start.kind === 'task';
        const startX = fromTask ? (start.x ?? 0) : (start.x ?? 0) + start.width / 2;
        const startY = fromTask ? (start.y ?? 0) + start.height / 2 : (start.y ?? 0);
        const endX = fromTask ? (end.x ?? 0) : (end.x ?? 0) - end.width / 2;
        const endY = fromTask ? (end.y ?? 0) - end.height / 2 : (end.y ?? 0);
        context.beginPath();
        context.moveTo(startX, startY);
        context.lineTo(endX, endY);
        context.lineWidth = 1.2;
        context.strokeStyle = this.colours.line;
        context.stroke();
        context.fillStyle = this.colours.line;
        arrowHead(context, endX, endY, Math.atan2(endY - startY, endX - startX));
    }

    private drawTask(node: SimNode, context: CanvasRenderingContext2D): void {
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
        context.fillText(node.label, left + 13, top + 18);
        const idWidth = context.measureText(node.label).width;
        context.font = `600 10px ${colours.font}`;
        context.fillStyle = state;
        context.fillText((TASK_STATE_WORDS[node.status] ?? 'WAIT').trim(), left + 21 + idWidth, top + 18);
        context.font = `11px ${colours.font}`;
        context.fillStyle = colours.label;
        context.fillText(fitted(context, node.tooltip, BOX_WIDTH - 22), left + 13, top + 35);
    }

    private drawStep(node: SimNode, context: CanvasRenderingContext2D): void {
        const colours = this.colours;
        const state = colours.states[node.status] ?? colours.states.pending;
        const left = (node.x ?? 0) - STEP_WIDTH / 2;
        const top = (node.y ?? 0) - STEP_HEIGHT / 2;
        context.beginPath();
        context.roundRect(left, top, STEP_WIDTH, STEP_HEIGHT, 5);
        context.fillStyle = colours.stepSurface;
        context.fill();
        context.lineWidth = node.status === 'running' ? 1.5 : 1;
        context.strokeStyle = node.status === 'running' ? state : colours.border;
        context.stroke();
        context.beginPath();
        context.roundRect(left, top, 4, STEP_HEIGHT, 2);
        context.fillStyle = state;
        context.fill();

        context.textAlign = 'left';
        context.textBaseline = 'middle';
        context.font = `10px ${colours.font}`;
        context.fillStyle = node.status === 'failed' ? state : colours.label;
        context.fillText(fitted(context, node.label, STEP_WIDTH - 16), left + 10, node.y ?? 0);
    }
}
