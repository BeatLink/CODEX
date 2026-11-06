// The workbench's state and how each daemon event and user action changes it, kept free of the DOM so it can be tested.
import { TASK_STEP_PREFIX, stepTaskId } from './taskView.js';
import type { RunSnapshot, Settings, Status, StepInput, TaskNode, UnfinishedRun } from './types.js';

export const FINAL_WAITING_TEXT = 'Your final response will appear here.';
export const BACKGROUND_WAITING_TEXT = 'Waiting for background work...';
export const DISCONNECTED_EVENT = 'daemon.disconnected';
// The task tree asks for approval with this question before any task changes files, runs tests, or calls MCP tools.
export const APPROVAL_QUESTION =
    'Approve these actions before anything is changed? Reply yes to go ahead; any other reply stops them.';
export const UNFINISHED_PROMPT_CHARS = 80;
export const SUSPENDED_TEXT = 'Suspended';
export const RESUMED_TEXT = 'CODEX is working again.';

export type Phase = 'task' | 'final';
export type StepSection = { label: string; system: string; input: string; text: string };
export type Clarification = { run_id: number; clarification_id: number; question: string; approval: boolean };
export type Connection = 'connecting' | 'connected' | 'unavailable';

export type WorkbenchState = {
    connection: Connection;
    settings: Settings | null;
    settingsPath: string;
    runId: number | null;
    running: boolean;
    cancelling: boolean;
    lastAnswer: string;
    // True while the view moves to each task as it starts running.
    followSteps: boolean;
    phase: Phase;
    chosenTaskId: string | null;
    collapsedTaskIds: string[];
    nodes: TaskNode[];
    steps: StepSection[];
    lastStepLabel: string;
    status: string;
    finalText: string;
    unfinishedRuns: UnfinishedRun[];
    backgroundStatus: string;
    backgroundOutput: string;
    clarifications: Clarification[];
    // True while the daemon is suspended and has freed the GPU.
    suspended: boolean;
};

export type Effect =
    | { kind: 'notify'; message: string; error?: boolean }
    | { kind: 'refresh_queue' }
    | { kind: 'refresh_unfinished' }
    | { kind: 'refresh_knowledge' }
    | { kind: 'show_settings'; settings: Settings };

export type Reduction = { state: WorkbenchState; effects: Effect[] };

// ============================================================================
// Starting state
// ============================================================================

export function initialState(): WorkbenchState {
    return {
        connection: 'connecting',
        settings: null,
        settingsPath: '',
        runId: null,
        running: false,
        cancelling: false,
        lastAnswer: '',
        followSteps: true,
        phase: 'final',
        chosenTaskId: null,
        collapsedTaskIds: [],
        nodes: [],
        steps: [],
        lastStepLabel: '',
        status: 'Connecting to the daemon...',
        finalText: FINAL_WAITING_TEXT,
        unfinishedRuns: [],
        backgroundStatus: 'Idle',
        backgroundOutput: '',
        clarifications: [],
        suspended: false,
    };
}

// ============================================================================
// Run view
// ============================================================================

function resetRunView(state: WorkbenchState): WorkbenchState {
    return { ...state, followSteps: true, steps: [], lastStepLabel: '', chosenTaskId: null, collapsedTaskIds: [], nodes: [], phase: 'final' };
}

export function beginRun(state: WorkbenchState, runId: number | null): WorkbenchState {
    return {
        ...resetRunView(state),
        runId,
        running: true,
        cancelling: false,
        finalText: '_Working on your request..._',
        status: 'Starting local model...',
    };
}

// Starts a new step whenever the step changes.
function noteStep(state: WorkbenchState, label: string): WorkbenchState {
    if (label === state.lastStepLabel) {
        return state;
    }
    return { ...state, lastStepLabel: label, steps: [...state.steps, { label, system: '', input: '', text: '' }] };
}

export function appendStepInput(state: WorkbenchState, label: string, input: StepInput): WorkbenchState {
    if (!label.startsWith(TASK_STEP_PREFIX)) {
        return state;
    }
    const noted = noteStep(state, label);
    const steps = noted.steps.slice();
    steps[steps.length - 1] = { ...steps[steps.length - 1], system: input.system, input: input.input };
    return { ...noted, steps };
}

export function appendStepOutput(state: WorkbenchState, label: string, token: string): WorkbenchState {
    if (!label.startsWith(TASK_STEP_PREFIX)) {
        return state;
    }
    const noted = noteStep(state, label);
    const steps = noted.steps.slice();
    const last = steps[steps.length - 1];
    steps[steps.length - 1] = { ...last, text: last.text + token };
    return { ...noted, steps };
}

export function updateProgress(state: WorkbenchState, label: string): WorkbenchState {
    let next = label.startsWith(TASK_STEP_PREFIX) ? noteStep(state, label) : state;
    if (label === 'Loading model') {
        return { ...next, status: 'Loading local model...' };
    }
    next = { ...next, status: label };
    if (label.startsWith(TASK_STEP_PREFIX) && next.followSteps) {
        next = showTask(next, stepTaskId(label));
    }
    return next;
}

export function showTaskTree(state: WorkbenchState, nodes: TaskNode[]): WorkbenchState {
    return { ...state, nodes };
}

// Shows a task and opens every branch above it, so its row is in sight.
function showTask(state: WorkbenchState, taskId: string): WorkbenchState {
    const collapsedTaskIds = state.collapsedTaskIds.filter((id) => !taskId.startsWith(`${id}.`));
    return { ...state, chosenTaskId: taskId, phase: 'task', collapsedTaskIds };
}

// Choosing a task or the final answer is the user's own pick, so the view stops following the running task.
export function chooseTask(state: WorkbenchState, taskId: string): WorkbenchState {
    return { ...showTask(state, taskId), followSteps: state.running ? false : state.followSteps };
}

export function chooseFinalAnswer(state: WorkbenchState): WorkbenchState {
    return { ...state, phase: 'final', chosenTaskId: null, followSteps: state.running ? false : state.followSteps };
}

export function setTaskOpen(state: WorkbenchState, taskId: string, open: boolean): WorkbenchState {
    const others = state.collapsedTaskIds.filter((id) => id !== taskId);
    return { ...state, collapsedTaskIds: open ? others : [...others, taskId] };
}

export function chosenTask(state: WorkbenchState): TaskNode | null {
    return state.nodes.find((node) => node.id === state.chosenTaskId) ?? null;
}

export function chosenTaskSteps(state: WorkbenchState): StepSection[] {
    return state.chosenTaskId === null ? [] : state.steps.filter((step) => stepTaskId(step.label) === state.chosenTaskId);
}

export function finishRun(state: WorkbenchState, result: string): WorkbenchState {
    return { ...state, lastAnswer: result, running: false, cancelling: false, finalText: result, phase: 'final', status: 'Complete' };
}

export function stopRun(state: WorkbenchState, finalText: string, status: string): WorkbenchState {
    return { ...state, running: false, cancelling: false, finalText, phase: 'final', status };
}

export function failRun(state: WorkbenchState, message: string): Reduction {
    return {
        state: stopRun(state, `**Run failed**\n\n${message}`, 'Run failed'),
        effects: [{ kind: 'notify', message, error: true }],
    };
}

export function cancelRequested(state: WorkbenchState): WorkbenchState {
    return { ...state, cancelling: true, status: 'Cancelling...' };
}

export function clearWorkbench(state: WorkbenchState): WorkbenchState {
    if (state.running) {
        return state;
    }
    return { ...resetRunView(state), finalText: FINAL_WAITING_TEXT, lastAnswer: '', status: 'Ready' };
}

// ============================================================================
// Unfinished runs
// ============================================================================

export function showUnfinishedRuns(state: WorkbenchState, runs: UnfinishedRun[]): WorkbenchState {
    return { ...state, unfinishedRuns: runs };
}

// Describes the newest run a crash, restart, or cancel left unfinished, or returns null when there is none to offer.
export function unfinishedRunText(state: WorkbenchState): string | null {
    if (state.running || state.unfinishedRuns.length === 0) {
        return null;
    }
    const run = state.unfinishedRuns[0];
    const prompt = run.prompt.split(/\s+/).filter(Boolean).join(' ');
    const shown = prompt.slice(0, UNFINISHED_PROMPT_CHARS) + (prompt.length > UNFINISHED_PROMPT_CHARS ? '…' : '');
    return `Unfinished: ${shown} (${run.tasks_done} of ${run.tasks_total} tasks done)`;
}

// ============================================================================
// Background work
// ============================================================================

export function setBackgroundStatus(state: WorkbenchState, message: string): WorkbenchState {
    const searching = message.startsWith('Searching:');
    return { ...state, backgroundStatus: message, backgroundOutput: searching ? '' : state.backgroundOutput };
}

// Sorts a background status message into idle, working, paused or error, for the status dot and the mascot.
export function backgroundState(message: string): 'idle' | 'working' | 'paused' | 'error' {
    if (message === 'Paused' || message === SUSPENDED_TEXT) return 'paused';
    if (message.startsWith('Worker error')) return 'error';
    if (message.startsWith('Idle') || message === 'Foreground prompt active') return 'idle';
    return 'working';
}

export function appendBackgroundToken(state: WorkbenchState, token: string): WorkbenchState {
    return { ...state, backgroundOutput: state.backgroundOutput + token };
}

// ============================================================================
// Clarifications and approvals
// ============================================================================

export function isApprovalQuestion(question: string): boolean {
    return question.startsWith(APPROVAL_QUESTION);
}

// Splits an approval question into its question and the planned actions it shows.
export function approvalPlan(question: string): string {
    return isApprovalQuestion(question) ? question.slice(APPROVAL_QUESTION.length).trim() : '';
}

export function requestClarification(state: WorkbenchState, runId: number, clarificationId: number, question: string): WorkbenchState {
    const clarification = { run_id: runId, clarification_id: clarificationId, question, approval: isApprovalQuestion(question) };
    return { ...state, clarifications: [...state.clarifications, clarification] };
}

export function clarificationAnswered(state: WorkbenchState, clarificationId: number): WorkbenchState {
    return { ...state, clarifications: state.clarifications.filter((item) => item.clarification_id !== clarificationId) };
}

// ============================================================================
// Suspending
// ============================================================================

// Tells the user when the daemon is suspended or resumed, and shows it as the status while no run is going.
export function setSuspended(state: WorkbenchState, suspended: boolean): Reduction {
    if (suspended === state.suspended) {
        return { state, effects: [] };
    }
    const next = { ...state, suspended, status: state.running ? state.status : suspended ? SUSPENDED_TEXT : 'Ready' };
    return { state: next, effects: [{ kind: 'notify', message: suspended ? SUSPENDED_TEXT : RESUMED_TEXT }] };
}

// ============================================================================
// Daemon status and events
// ============================================================================

// Shows what the daemon reports on connecting, including a run another interface started.
export function applyStatus(state: WorkbenchState, status: Status): Reduction {
    let next: WorkbenchState = {
        ...state,
        connection: 'connected',
        settings: status.settings,
        settingsPath: status.settings_path,
        backgroundOutput: status.background.output,
    };
    next = setBackgroundStatus(next, status.background.status);
    const run: RunSnapshot | null = status.run;
    if (run === null) {
        next = { ...next, status: next.suspended ? SUSPENDED_TEXT : 'Ready' };
    } else {
        next = showTaskTree(beginRun(next, run.run_id), run.tree);
        const inputs = run.inputs ?? {};
        for (const label of new Set([...run.progress, ...Object.keys(inputs), ...Object.keys(run.outputs)])) {
            if (label in inputs) {
                next = appendStepInput(next, label, inputs[label]);
            }
            next = appendStepOutput(next, label, run.outputs[label] ?? '');
        }
        if (run.progress.length > 0) {
            next = updateProgress(next, run.progress[run.progress.length - 1]);
        }
    }
    next = showUnfinishedRuns(next, status.unfinished_runs);
    const suspension = setSuspended(next, Boolean(status.suspended));
    return {
        state: suspension.state,
        effects: [
            { kind: 'show_settings', settings: status.settings },
            { kind: 'refresh_knowledge' },
            { kind: 'refresh_queue' },
            ...suspension.effects,
        ],
    };
}

export function connectionFailed(state: WorkbenchState, message: string): Reduction {
    return { state: { ...state, connection: 'unavailable', status: 'Daemon unavailable' }, effects: [{ kind: 'notify', message, error: true }] };
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : String(value ?? '');
}

export function reduceEvent(state: WorkbenchState, event: string, data: Record<string, unknown>): Reduction {
    switch (event) {
        case 'run.started':
            if (!state.running || state.runId === null) {
                return { state: beginRun(state, Number(data.run_id)), effects: [] };
            }
            return { state, effects: [] };
        case 'run.tree':
            return { state: showTaskTree(state, (data.nodes as TaskNode[]) ?? []), effects: [] };
        case 'run.progress':
            return { state: updateProgress(state, text(data.label)), effects: [] };
        case 'run.input':
            return { state: appendStepInput(state, text(data.label), { system: text(data.system), input: text(data.input) }), effects: [] };
        case 'run.token':
            return { state: appendStepOutput(state, text(data.label), text(data.token)), effects: [] };
        case 'run.clarification':
            return {
                state: requestClarification(state, Number(data.run_id), Number(data.clarification_id), text(data.question)),
                effects: [],
            };
        case 'run.finished':
            return { state: finishRun({ ...state, clarifications: [] }, text(data.result)), effects: [] };
        case 'run.failed':
            return failRun({ ...state, clarifications: [] }, text(data.message));
        case 'run.cancelled':
            return { state: stopRun({ ...state, clarifications: [] }, '_Run cancelled._', 'Cancelled'), effects: [] };
        case 'background.status':
            return { state: setBackgroundStatus(state, text(data.message)), effects: [] };
        case 'background.token':
            return { state: appendBackgroundToken(state, text(data.token)), effects: [] };
        case 'queue.changed':
            return { state, effects: [{ kind: 'refresh_queue' }] };
        case 'runs.changed':
            return { state, effects: [{ kind: 'refresh_unfinished' }] };
        case 'knowledge.changed':
            return { state, effects: [{ kind: 'refresh_knowledge' }] };
        case 'settings.changed':
            return { state: { ...state, settings: data.settings as Settings }, effects: [] };
        case 'suspended.changed':
            return setSuspended(state, Boolean(data.suspended));
        case DISCONNECTED_EVENT: {
            let next = state;
            const effects: Effect[] = [];
            if (state.running) {
                const failed = failRun(state, 'The daemon closed the connection.');
                next = failed.state;
                effects.push(...failed.effects);
            }
            next = { ...next, connection: 'unavailable', status: 'Daemon unavailable', clarifications: [] };
            effects.push({ kind: 'notify', message: 'Lost the connection to the CODEX daemon.', error: true });
            return { state: next, effects };
        }
        default:
            return { state, effects: [] };
    }
}
