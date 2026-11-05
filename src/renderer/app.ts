// The CODEX window: wires the pages to the daemon through the preload API and draws the workbench state.
import { factsMarkdown, graphMarkdown, NO_FACTS_TEXT, queueLines, sourcesMarkdown, topicRows } from './knowledgeView.js';
import { markdownToHtml } from './markdown.js';
import {
    applyStatus,
    approvalPlan,
    beginRun,
    BACKGROUND_WAITING_TEXT,
    cancelRequested,
    chooseTask,
    choosePhase,
    chosenTask,
    clarificationAnswered,
    clearWorkbench,
    connectionFailed,
    initialState,
    reduceEvent,
    showUnfinishedRuns,
    stopRun,
    STEPS_WAITING_TEXT,
    SUSPENDED_TEXT,
    TASK_DETAIL_WAITING_TEXT,
    unfinishedRunText,
    type Clarification,
    type Effect,
    type Reduction,
    type WorkbenchState,
} from './runState.js';
import {
    applySizeChoice,
    autoSizeRequest,
    collectSettings,
    FIELD_GROUPS,
    MCP_SERVERS_HINT,
    MODE_CHOICES,
    MODE_NAMES,
    numberFields,
    pathFields,
    settingsToForm,
    sizeChoiceMessage,
    switchFields,
    type FormValues,
    type NumberField,
    type PathField,
} from './settingsForm.js';
import { commandSuggestions, completeCommand, type CommandSuggestion } from './slashCommands.js';
import { taskDetailMarkdown, taskTreeRows } from './taskView.js';
import type { CodexApi, Knowledge, ResearchJob, Settings, SizeChoice, Status, UnfinishedRun, UserCommand } from './types.js';

const codex = (window as unknown as { codex: CodexApi }).codex;
const RENDER_INTERVAL_MILLISECONDS = 150;
const NOTICE_SECONDS = 8;
const COMMAND_CACHE_MILLISECONDS = 5000;
// The main process sends this alongside the daemon's events when launch at login changes from the tray.
const AUTOSTART_CHANGED_EVENT = 'autostart.changed';

let state: WorkbenchState = initialState();
let knowledge: Knowledge = { topics: [], sources: [], graph: [] };
let knowledgeQuery = '';
let knowledgeTopicId: number | null = null;

// ============================================================================
// Elements
// ============================================================================

function element<T extends HTMLElement = HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (found === null) {
        throw new Error(`Missing element #${id}`);
    }
    return found as T;
}

const view = {
    connection: element('connection'),
    notice: element('notice'),
    noticeText: element('notice-text'),
    backgroundDot: element('background-dot'),
    backgroundPillText: element('background-pill-text'),
    backgroundToggle: element<HTMLButtonElement>('background-toggle'),
    taskList: element('task-list'),
    taskEmpty: element('task-empty'),
    runStatus: element('run-status'),
    prompt: element<HTMLTextAreaElement>('prompt'),
    suggestions: element('command-suggestions'),
    mode: element<HTMLSelectElement>('mode'),
    run: element<HTMLButtonElement>('run'),
    cancel: element<HTMLButtonElement>('cancel'),
    clear: element<HTMLButtonElement>('clear'),
    copy: element<HTMLButtonElement>('copy'),
    resumeBar: element('resume-bar'),
    resumeText: element('resume-text'),
    phaseTitle: element('phase-title'),
    outputSteps: element('output-steps'),
    outputTask: element('output-task'),
    outputFinal: element('output-final'),
    backgroundStatus: element('background-status'),
    backgroundEnabled: element<HTMLInputElement>('background-enabled'),
    researchTopic: element<HTMLInputElement>('research-topic'),
    researchPriority: element<HTMLInputElement>('research-priority'),
    backgroundQueue: element('background-queue'),
    backgroundOutput: element('background-output'),
    knowledgeSearch: element<HTMLInputElement>('knowledge-search'),
    topicList: element('topic-list'),
    sourcesTitle: element('sources-title'),
    knowledgeDetail: element('knowledge-detail'),
    knowledgeFacts: element('knowledge-facts'),
    knowledgeGraph: element('knowledge-graph'),
    optionsForm: element<HTMLFormElement>('options-form'),
    settingsPath: element('settings-path'),
    dialog: element<HTMLDialogElement>('clarification-dialog'),
    dialogEyebrow: element('clarification-eyebrow'),
    dialogQuestion: element('clarification-question'),
    dialogPlan: element('clarification-plan'),
    dialogLabel: element('clarification-label'),
    dialogAnswer: element<HTMLTextAreaElement>('clarification-answer'),
    dialogSkip: element<HTMLButtonElement>('clarification-skip'),
    dialogSubmit: element<HTMLButtonElement>('clarification-submit'),
};

// ============================================================================
// Notices and daemon calls
// ============================================================================

let noticeTimer: number | null = null;

function notifyUser(message: string, error = false): void {
    view.noticeText.textContent = message;
    view.notice.dataset.error = String(error);
    view.notice.hidden = false;
    if (noticeTimer !== null) {
        window.clearTimeout(noticeTimer);
    }
    noticeTimer = window.setTimeout(() => {
        view.notice.hidden = true;
        noticeTimer = null;
    }, NOTICE_SECONDS * 1000);
}

// Calls the daemon and reports a failure as a notice; resolves to null when the call failed.
async function callDaemon<T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
    try {
        return await codex.request<T>(method, params);
    } catch (error) {
        notifyUser((error as Error).message, true);
        return null;
    }
}

// ============================================================================
// State changes
// ============================================================================

function dispatch(reduction: Reduction | WorkbenchState): void {
    if ('effects' in reduction) {
        state = reduction.state;
        reduction.effects.forEach(runEffect);
    } else {
        state = reduction;
    }
    scheduleRender();
}

function runEffect(effect: Effect): void {
    switch (effect.kind) {
        case 'notify':
            notifyUser(effect.message, effect.error);
            break;
        case 'refresh_queue':
            void refreshQueue();
            break;
        case 'refresh_unfinished':
            void callDaemon<UnfinishedRun[]>('unfinished_runs').then((runs) => dispatch(showUnfinishedRuns(state, runs ?? [])));
            break;
        case 'refresh_knowledge':
            void refreshKnowledge();
            break;
        case 'show_settings':
            showSettings(effect.settings);
            break;
    }
}

// ============================================================================
// Drawing the workbench
// ============================================================================

let renderTimer: number | null = null;
let lastRenderAt = 0;

function scheduleRender(): void {
    if (renderTimer !== null) {
        return;
    }
    const wait = Math.max(0, RENDER_INTERVAL_MILLISECONDS - (performance.now() - lastRenderAt));
    renderTimer = window.setTimeout(() => {
        renderTimer = null;
        lastRenderAt = performance.now();
        render();
    }, wait);
}

// Keeps the newest text in sight unless the reader has scrolled up.
function keepFollowing(target: HTMLElement, update: () => void): void {
    const following = target.scrollTop >= target.scrollHeight - target.clientHeight - 4;
    update();
    if (following) {
        target.scrollTop = target.scrollHeight;
    }
}

function setMarkdown(target: HTMLElement, text: string): void {
    const html = markdownToHtml(text);
    if (target.dataset.source !== html) {
        target.dataset.source = html;
        target.innerHTML = html;
    }
}

let drawnSteps: Array<{ label: string; body: Text }> = [];

function renderSteps(): void {
    const output = view.outputSteps;
    if (state.steps.length === 0) {
        if (drawnSteps.length > 0 || output.textContent !== STEPS_WAITING_TEXT) {
            drawnSteps = [];
            output.textContent = STEPS_WAITING_TEXT;
        }
        return;
    }
    keepFollowing(output, () => {
        if (drawnSteps.length === 0 || drawnSteps.length > state.steps.length || drawnSteps[0].label !== state.steps[0].label) {
            drawnSteps = [];
            output.textContent = '';
        }
        state.steps.forEach((section, index) => {
            if (index >= drawnSteps.length) {
                const heading = document.createElement('span');
                heading.className = 'step-heading';
                heading.textContent = `▸ ${section.label}`;
                const body = document.createTextNode('');
                output.append(heading, body);
                drawnSteps.push({ label: section.label, body });
            }
            const body = drawnSteps[index].body;
            const text = index === 0 ? section.text.replace(/^\s+/, '') : section.text;
            if (body.data !== text) {
                body.data = text;
            }
        });
    });
}

let drawnNodes: unknown = null;
let drawnChosen: string | null | undefined;

function renderTaskTree(): void {
    if (drawnNodes === state.nodes && drawnChosen === state.chosenTaskId) {
        return;
    }
    drawnNodes = state.nodes;
    drawnChosen = state.chosenTaskId;
    view.taskList.textContent = '';
    for (const row of taskTreeRows(state.nodes)) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.className = 'task-row';
        button.dataset.taskId = row.id;
        button.dataset.status = row.status;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(row.id === state.chosenTaskId));
        button.style.paddingLeft = `${8 + row.depth * 14}px`;
        const stateWord = document.createElement('span');
        stateWord.className = 'state';
        stateWord.textContent = row.state;
        const identifier = document.createElement('span');
        identifier.className = 'task-id';
        identifier.textContent = row.id;
        const prompt = document.createElement('span');
        prompt.textContent = row.prompt;
        button.append(stateWord, identifier, prompt);
        item.append(button);
        view.taskList.append(item);
    }
    view.taskEmpty.hidden = state.nodes.length > 0;
}

function renderWorkbench(): void {
    view.runStatus.textContent = state.status;
    view.run.disabled = state.running || state.connection !== 'connected';
    view.clear.disabled = state.running;
    view.cancel.disabled = !state.running || state.cancelling;
    view.copy.disabled = state.running || !state.lastAnswer;
    view.prompt.readOnly = state.running;
    const resume = unfinishedRunText(state);
    view.resumeBar.hidden = resume === null;
    view.resumeText.textContent = resume ?? '';

    for (const button of document.querySelectorAll<HTMLButtonElement>('.phase')) {
        button.setAttribute('aria-selected', String(button.dataset.phase === state.phase));
    }
    view.outputSteps.hidden = state.phase !== 'steps';
    view.outputTask.hidden = state.phase !== 'task';
    view.outputFinal.hidden = state.phase !== 'final';
    view.phaseTitle.textContent =
        state.phase === 'steps' ? 'Steps' : state.phase === 'task' ? `Task ${state.chosenTaskId ?? ''}` : 'Final answer';

    renderTaskTree();
    renderSteps();
    const task = chosenTask(state);
    setMarkdown(view.outputTask, task === null ? TASK_DETAIL_WAITING_TEXT : taskDetailMarkdown(task));
    keepFollowing(view.outputFinal, () => setMarkdown(view.outputFinal, state.finalText));
}

function backgroundState(message: string): string {
    if (message === 'Paused' || message === SUSPENDED_TEXT) return 'paused';
    if (message.startsWith('Worker error')) return 'error';
    if (message.startsWith('Idle') || message === 'Foreground prompt active') return 'idle';
    return 'working';
}

function renderBackground(): void {
    const enabled = Boolean(state.settings?.background_research_enabled);
    view.backgroundStatus.textContent = state.backgroundStatus;
    view.backgroundPillText.textContent = state.backgroundStatus;
    view.backgroundDot.dataset.state = backgroundState(state.backgroundStatus);
    view.backgroundToggle.textContent = enabled ? 'Pause' : 'Resume';
    view.backgroundToggle.disabled = state.settings === null;
    view.backgroundEnabled.checked = enabled;
    const output = view.backgroundOutput;
    const text = state.backgroundOutput || BACKGROUND_WAITING_TEXT;
    if (output.textContent !== text) {
        keepFollowing(output, () => {
            output.textContent = text;
        });
    }
}

function renderConnection(): void {
    view.connection.dataset.state = state.connection;
    view.connection.textContent =
        state.connection === 'connected' ? 'Connected' : state.connection === 'connecting' ? 'Connecting' : 'Daemon unavailable';
}

function render(): void {
    renderConnection();
    renderWorkbench();
    renderBackground();
    renderClarification();
}

// ============================================================================
// Clarifications and approvals
// ============================================================================

let shownClarification: Clarification | null = null;

// Shows the oldest waiting question; a run that ended takes its open question away.
function renderClarification(): void {
    if (shownClarification !== null && !state.clarifications.includes(shownClarification)) {
        shownClarification = null;
        view.dialog.close();
    }
    if (shownClarification !== null || state.clarifications.length === 0) {
        return;
    }
    const clarification = state.clarifications[0];
    shownClarification = clarification;
    const plan = approvalPlan(clarification.question);
    view.dialogEyebrow.textContent = clarification.approval ? 'Approve actions' : 'Clarification';
    view.dialogQuestion.textContent = clarification.approval
        ? 'These tasks want to change files, run tests, or call MCP tools. Approve them before anything is changed?'
        : clarification.question;
    view.dialogPlan.hidden = !clarification.approval;
    view.dialogPlan.textContent = plan;
    view.dialogLabel.textContent = clarification.approval ? 'Reply (optional)' : 'Your response';
    view.dialogSkip.textContent = clarification.approval ? 'Decline' : 'Skip';
    view.dialogSubmit.textContent = clarification.approval ? 'Approve' : 'Continue';
    view.dialogAnswer.value = '';
    view.dialog.showModal();
    view.dialogAnswer.focus();
}

function answerClarification(submitted: boolean): void {
    const clarification = shownClarification;
    if (clarification === null) {
        return;
    }
    const typed = view.dialogAnswer.value.trim();
    let answer = submitted ? typed : '';
    if (clarification.approval) {
        // The task tree goes ahead only when the reply starts with yes.
        answer = submitted ? `yes${typed ? `. ${typed}` : ''}` : typed || 'no';
    }
    shownClarification = null;
    view.dialog.close();
    dispatch(clarificationAnswered(state, clarification.clarification_id));
    void callDaemon('answer_clarification', {
        run_id: clarification.run_id,
        clarification_id: clarification.clarification_id,
        answer,
    });
}

// ============================================================================
// Settings form
// ============================================================================

function fieldId(name: string): string {
    return `setting-${name}`;
}

function numberInput(field: NumberField): HTMLElement {
    const label = document.createElement('label');
    label.className = 'field';
    const caption = document.createElement('span');
    caption.className = 'field-label';
    caption.textContent = field.label;
    const input = document.createElement('input');
    input.type = 'number';
    input.id = fieldId(field.name);
    input.min = String(field.lowest);
    input.max = String(field.highest);
    input.step = String(field.step);
    label.append(caption, input);
    return label;
}

function pathInput(field: PathField): HTMLElement {
    const label = document.createElement('label');
    label.className = 'field';
    const caption = document.createElement('span');
    caption.className = 'field-label';
    caption.textContent = field.label;
    const row = document.createElement('div');
    row.className = 'path-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = fieldId(field.name);
    input.spellcheck = false;
    const browse = document.createElement('button');
    browse.type = 'button';
    browse.textContent = 'Browse…';
    browse.addEventListener('click', () => void browseForPath(field, input));
    row.append(input, browse);
    label.append(caption, row);
    return label;
}

async function browseForPath(field: PathField, input: HTMLInputElement): Promise<void> {
    const defaultPath = input.value.trim() || undefined;
    let chosen: string | null = null;
    try {
        if (field.kind === 'directory') {
            chosen = await codex.openDialog({ title: field.label, defaultPath, directory: true });
        } else if (field.kind === 'database') {
            chosen = await codex.saveDialog({
                title: field.label,
                defaultPath,
                filters: [{ name: 'SQLite database', extensions: ['sqlite3', 'sqlite', 'db'] }],
            });
        } else {
            chosen = await codex.openDialog({
                title: field.label,
                defaultPath,
                filters: [{ name: 'GGUF model', extensions: ['gguf'] }, { name: 'All files', extensions: ['*'] }],
            });
        }
    } catch (error) {
        notifyUser((error as Error).message, true);
    }
    if (chosen !== null) {
        input.value = chosen;
    }
}

function buildOptionsForm(): void {
    for (const group of FIELD_GROUPS) {
        const section = document.createElement('fieldset');
        section.className = 'options-group';
        const heading = document.createElement('h2');
        heading.className = 'eyebrow';
        heading.textContent = group.heading;
        section.append(heading);
        const grid = (fields: NumberField[]): void => {
            const box = document.createElement('div');
            box.className = 'number-grid';
            fields.forEach((field) => box.append(numberInput(field)));
            section.append(box);
        };
        if (group.heading === 'Background research') {
            grid(group.numbers ?? []);
            (group.paths ?? []).forEach((field) => section.append(pathInput(field)));
            grid(group.after ?? []);
        } else {
            (group.paths ?? []).forEach((field) => section.append(pathInput(field)));
            if (group.numbers) grid(group.numbers);
        }
        for (const field of group.switches ?? []) {
            const row = document.createElement('label');
            row.className = 'switch-row';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = fieldId(field.name);
            const caption = document.createElement('span');
            caption.textContent = field.label;
            row.append(input, caption);
            section.append(row);
        }
        view.optionsForm.append(section);
    }
    const mcp = document.createElement('fieldset');
    mcp.className = 'options-group wide';
    mcp.innerHTML = `<h2 class="eyebrow">MCP servers</h2><span class="field-label"></span><textarea id="mcp-servers" spellcheck="false"></textarea>`;
    (mcp.querySelector('.field-label') as HTMLElement).textContent = MCP_SERVERS_HINT;
    view.optionsForm.append(mcp);
    // Launch at login belongs to this computer rather than the daemon, so it takes effect at once instead of on Apply.
    const desktop = document.createElement('fieldset');
    desktop.className = 'options-group';
    desktop.innerHTML =
        '<h2 class="eyebrow">Desktop</h2><label class="switch-row"><input type="checkbox" id="launch-at-login"><span>Launch at login, in the system tray</span></label>';
    view.optionsForm.append(desktop);
}

async function setLaunchAtLogin(enabled: boolean): Promise<void> {
    const input = element<HTMLInputElement>('launch-at-login');
    try {
        input.checked = await codex.setAutostart(enabled);
        notifyUser(input.checked ? 'CODEX will start in the tray when you log in.' : 'CODEX will no longer start when you log in.');
    } catch (error) {
        input.checked = !enabled;
        notifyUser((error as Error).message, true);
    }
}

async function showLaunchAtLogin(): Promise<void> {
    try {
        element<HTMLInputElement>('launch-at-login').checked = await codex.getAutostart();
    } catch {
        // The switch stays as it is when the main process cannot read the entry.
    }
}

function readForm(): FormValues {
    const text: Record<string, string> = {};
    for (const field of [...pathFields(), ...numberFields()]) {
        text[field.name] = element<HTMLInputElement>(fieldId(field.name)).value;
    }
    const switches: Record<string, boolean> = {};
    for (const field of switchFields()) {
        switches[field.name] = element<HTMLInputElement>(fieldId(field.name)).checked;
    }
    return {
        text,
        switches,
        mcp_servers: element<HTMLTextAreaElement>('mcp-servers').value,
        mode: view.mode.value,
        background_research_enabled: view.backgroundEnabled.checked,
    };
}

function writeForm(form: FormValues): void {
    for (const [name, value] of Object.entries(form.text)) {
        element<HTMLInputElement>(fieldId(name)).value = value;
    }
    for (const [name, value] of Object.entries(form.switches)) {
        element<HTMLInputElement>(fieldId(name)).checked = value;
    }
    element<HTMLTextAreaElement>('mcp-servers').value = form.mcp_servers;
    view.mode.value = form.mode;
    view.backgroundEnabled.checked = form.background_research_enabled;
}

function showSettings(settings: Settings): void {
    state = { ...state, settings };
    writeForm(settingsToForm(settings));
    scheduleRender();
}

// Reads the form into settings, or tells the user what is wrong and returns null.
function formSettings(): Settings | null {
    if (state.settings === null) {
        notifyUser('Not connected to the daemon yet.', true);
        return null;
    }
    try {
        return collectSettings(state.settings, readForm());
    } catch (error) {
        notifyUser(`Invalid settings: ${(error as Error).message}`, true);
        return null;
    }
}

async function applySettings(): Promise<void> {
    const settings = formSettings();
    if (settings === null) return;
    const applied = await callDaemon<Settings>('apply_settings', { settings });
    if (applied !== null) {
        showSettings(applied);
        notifyUser('Settings applied.');
    }
}

async function saveSettings(): Promise<void> {
    const settings = formSettings();
    if (settings === null) return;
    const saved = await callDaemon<{ settings: Settings; path: string }>('save_settings', { settings });
    if (saved !== null) {
        showSettings(saved.settings);
        notifyUser(`Settings saved to ${saved.path}.`);
    }
}

// Fills the context and token limits from the model file and free memory, ready to apply or save.
async function autoSize(): Promise<void> {
    let request: Record<string, unknown>;
    try {
        request = autoSizeRequest(readForm());
    } catch (error) {
        notifyUser(`Invalid settings: ${(error as Error).message}`, true);
        return;
    }
    notifyUser('Sizing the models for this machine...');
    const choice = await callDaemon<SizeChoice>('auto_size', request);
    if (choice !== null) {
        writeForm(applySizeChoice(readForm(), choice));
        notifyUser(sizeChoiceMessage(choice));
    }
}

// ============================================================================
// Foreground run
// ============================================================================

async function startRun(): Promise<void> {
    if (state.running) return;
    const prompt = view.prompt.value.trim();
    if (!prompt) {
        notifyUser('Enter a prompt before running.');
        view.prompt.focus();
        return;
    }
    const settings = formSettings();
    if (settings === null) return;
    hideSuggestions();
    dispatch(beginRun(state, null));
    const applied = await callDaemon<Settings>('apply_settings', { settings });
    if (applied === null) {
        dispatch(stopRun(state, '_The request could not start._', 'Ready'));
        return;
    }
    state = { ...state, settings: applied };
    const started = await callDaemon<{ run_id: number }>('run', { prompt, settings });
    if (started === null) {
        dispatch(stopRun(state, '_The request could not start._', 'Ready'));
        return;
    }
    dispatch({ ...state, runId: started.run_id });
}

async function resumeRun(): Promise<void> {
    if (state.running || state.unfinishedRuns.length === 0) return;
    const run = state.unfinishedRuns[0];
    view.prompt.value = run.prompt;
    dispatch(beginRun(state, null));
    const started = await callDaemon<{ run_id: number }>('resume_run', { run_id: run.id });
    if (started === null) {
        dispatch(stopRun(state, '_The request could not resume._', 'Ready'));
        return;
    }
    dispatch({ ...state, runId: started.run_id });
}

async function discardRun(): Promise<void> {
    if (state.unfinishedRuns.length === 0) return;
    const remaining = state.unfinishedRuns.slice(1);
    if ((await callDaemon('discard_run', { run_id: state.unfinishedRuns[0].id })) !== null) {
        dispatch(showUnfinishedRuns(state, remaining));
    }
}

function cancelRun(): void {
    if (!state.running) return;
    void callDaemon('cancel', { run_id: state.runId });
    dispatch(cancelRequested(state));
}

function clearRun(): void {
    if (state.running) return;
    view.prompt.value = '';
    dispatch(clearWorkbench(state));
}

async function copyAnswer(): Promise<void> {
    if (!state.lastAnswer) return;
    try {
        await codex.copyText(state.lastAnswer);
        notifyUser('Copied the answer.');
    } catch (error) {
        notifyUser((error as Error).message, true);
    }
}

// ============================================================================
// Slash command suggestions
// ============================================================================

let userCommands: UserCommand[] = [];
let commandsLoadedAt = 0;
let commandsRoot = '';
let suggestions: CommandSuggestion[] = [];
let suggestionIndex = 0;

async function loadUserCommands(): Promise<void> {
    const root = String(state.settings?.filesystem_root ?? '');
    if (root === commandsRoot && performance.now() - commandsLoadedAt < COMMAND_CACHE_MILLISECONDS) return;
    commandsRoot = root;
    commandsLoadedAt = performance.now();
    try {
        userCommands = await codex.listCommands(root);
    } catch {
        userCommands = [];
    }
}

function hideSuggestions(): void {
    suggestions = [];
    view.suggestions.hidden = true;
}

function drawSuggestions(): void {
    view.suggestions.textContent = '';
    suggestions.forEach((suggestion, index) => {
        const item = document.createElement('li');
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(index === suggestionIndex));
        const usage = document.createElement('span');
        usage.className = 'usage';
        usage.textContent = suggestion.usage;
        const description = document.createElement('span');
        description.className = 'description';
        description.textContent = suggestion.description;
        item.append(usage, description);
        item.addEventListener('mousedown', (event) => {
            event.preventDefault();
            takeSuggestion(index);
        });
        view.suggestions.append(item);
    });
    view.suggestions.hidden = suggestions.length === 0;
}

async function updateSuggestions(): Promise<void> {
    if (!view.prompt.value.trimStart().startsWith('/')) {
        hideSuggestions();
        return;
    }
    await loadUserCommands();
    suggestions = commandSuggestions(view.prompt.value, userCommands);
    suggestionIndex = 0;
    drawSuggestions();
}

function takeSuggestion(index: number): void {
    const suggestion = suggestions[index];
    if (suggestion === undefined) return;
    view.prompt.value = completeCommand(view.prompt.value, suggestion.name);
    view.prompt.setSelectionRange(view.prompt.value.length, view.prompt.value.length);
    hideSuggestions();
    view.prompt.focus();
}

// ============================================================================
// Background research
// ============================================================================

async function refreshQueue(): Promise<void> {
    let jobs: ResearchJob[] = [];
    try {
        jobs = await codex.request<ResearchJob[]>('queue_status');
    } catch {
        jobs = [];
    }
    view.backgroundQueue.textContent = queueLines(jobs);
}

async function setBackgroundEnabled(enabled: boolean): Promise<void> {
    const applied = await callDaemon<Settings>('set_background_enabled', { enabled });
    if (applied !== null) {
        state = { ...state, settings: applied };
    }
    scheduleRender();
}

async function queueTopic(): Promise<boolean> {
    const topic = view.researchTopic.value.trim();
    if (!topic) {
        notifyUser('Enter a topic to research.');
        return false;
    }
    const priority = Number(view.researchPriority.value);
    if (!Number.isInteger(priority)) {
        notifyUser('Priority must be an integer.', true);
        return false;
    }
    if ((await callDaemon('queue_topic', { topic, priority })) === null) {
        return false;
    }
    view.researchTopic.value = '';
    return true;
}

async function researchNow(): Promise<void> {
    if (view.researchTopic.value.trim() && !(await queueTopic())) {
        return;
    }
    await callDaemon('research_now');
}

// ============================================================================
// Knowledge browser
// ============================================================================

async function refreshKnowledge(): Promise<void> {
    let reply: Knowledge;
    try {
        reply = await codex.request<Knowledge>('knowledge', { query: knowledgeQuery, topic_id: knowledgeTopicId });
    } catch {
        return;
    }
    knowledge = reply;
    renderKnowledge();
}

function renderKnowledge(): void {
    view.topicList.textContent = '';
    for (const row of topicRows(knowledge.topics)) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.className = 'topic-row-item';
        button.textContent = row.text;
        button.title = row.text;
        button.style.paddingLeft = `${8 + row.depth * 16}px`;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(!knowledgeQuery && row.id === knowledgeTopicId));
        button.addEventListener('click', () => {
            knowledgeQuery = '';
            view.knowledgeSearch.value = '';
            knowledgeTopicId = row.id;
            void refreshKnowledge();
        });
        item.append(button);
        view.topicList.append(item);
    }
    view.sourcesTitle.textContent = knowledgeQuery ? `Sources matching "${knowledgeQuery}"` : 'Sources';
    setMarkdown(view.knowledgeDetail, sourcesMarkdown(knowledge.sources));
    setMarkdown(view.knowledgeFacts, knowledge.facts ? factsMarkdown(knowledge.facts) : NO_FACTS_TEXT);
    setMarkdown(view.knowledgeGraph, graphMarkdown(knowledge.graph));
}

function searchKnowledge(): void {
    knowledgeQuery = view.knowledgeSearch.value.trim();
    knowledgeTopicId = null;
    void refreshKnowledge();
}

// ============================================================================
// Pages and controls
// ============================================================================

function showPage(name: string): void {
    for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
        tab.setAttribute('aria-selected', String(tab.dataset.page === name));
    }
    for (const page of document.querySelectorAll<HTMLElement>('.page')) {
        page.hidden = page.id !== `page-${name}`;
    }
    if (name === 'background') void refreshQueue();
    if (name === 'knowledge') void refreshKnowledge();
}

function bindControls(): void {
    for (const choice of MODE_CHOICES) {
        const option = document.createElement('option');
        option.value = choice;
        option.textContent = MODE_NAMES[choice];
        view.mode.append(option);
    }
    for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
        tab.addEventListener('click', () => showPage(tab.dataset.page ?? 'workbench'));
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('.phase')) {
        button.addEventListener('click', () => dispatch(choosePhase(state, button.dataset.phase === 'steps' ? 'steps' : 'final')));
    }
    view.taskList.addEventListener('click', (event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>('.task-row');
        if (row?.dataset.taskId) dispatch(chooseTask(state, row.dataset.taskId));
    });
    element('notice-close').addEventListener('click', () => {
        view.notice.hidden = true;
    });
    view.run.addEventListener('click', () => void startRun());
    view.cancel.addEventListener('click', cancelRun);
    view.clear.addEventListener('click', clearRun);
    view.copy.addEventListener('click', () => void copyAnswer());
    element('resume-run').addEventListener('click', () => void resumeRun());
    element('discard-run').addEventListener('click', () => void discardRun());

    view.prompt.addEventListener('input', () => void updateSuggestions());
    view.prompt.addEventListener('blur', hideSuggestions);
    view.prompt.addEventListener('keydown', (event) => {
        if (suggestions.length === 0) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            suggestionIndex = (suggestionIndex + step + suggestions.length) % suggestions.length;
            drawSuggestions();
        } else if ((event.key === 'Tab' || event.key === 'Enter') && !event.ctrlKey) {
            event.preventDefault();
            takeSuggestion(suggestionIndex);
        } else if (event.key === 'Escape') {
            hideSuggestions();
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.ctrlKey && (event.key === 'Enter' || event.key.toLowerCase() === 'r') && !view.dialog.open) {
            event.preventDefault();
            void startRun();
        }
    });

    view.backgroundToggle.addEventListener('click', () => void setBackgroundEnabled(!state.settings?.background_research_enabled));
    view.backgroundEnabled.addEventListener('change', () => void setBackgroundEnabled(view.backgroundEnabled.checked));
    element('queue-topic').addEventListener('click', () => void queueTopic());
    element('research-now').addEventListener('click', () => void researchNow());
    for (const input of [view.researchTopic, view.researchPriority]) {
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') void queueTopic();
        });
    }

    view.knowledgeSearch.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') searchKnowledge();
    });
    element('search-knowledge').addEventListener('click', searchKnowledge);
    element('refresh-knowledge').addEventListener('click', () => void refreshKnowledge());

    const launchAtLogin = element<HTMLInputElement>('launch-at-login');
    launchAtLogin.addEventListener('change', () => void setLaunchAtLogin(launchAtLogin.checked));
    element('apply-options').addEventListener('click', () => void applySettings());
    element('save-options').addEventListener('click', () => void saveSettings());
    element('auto-size').addEventListener('click', () => void autoSize());

    element('clarification-form').addEventListener('submit', (event) => {
        event.preventDefault();
        answerClarification(true);
    });
    view.dialogSkip.addEventListener('click', () => answerClarification(false));
    // Closing the question with Escape counts as skipping it.
    view.dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        answerClarification(false);
    });
}

// ============================================================================
// Start
// ============================================================================

async function start(): Promise<void> {
    buildOptionsForm();
    bindControls();
    codex.onEvent((event, data) => {
        if (event === AUTOSTART_CHANGED_EVENT) {
            element<HTMLInputElement>('launch-at-login').checked = Boolean(data.enabled);
            return;
        }
        dispatch(reduceEvent(state, event, data));
    });
    void showLaunchAtLogin();
    render();
    view.prompt.focus();
    try {
        await codex.connect();
        const status = await codex.request<Status>('status');
        dispatch(applyStatus(state, status));
        view.settingsPath.textContent = status.settings_path ? `Saves to ${status.settings_path}` : '';
    } catch (error) {
        dispatch(connectionFailed(state, (error as Error).message));
    }
}

void start();
