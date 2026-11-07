// The subtask steps of a task: plan subtasks, run them in order, re-plan the rest after a failure, combine, and follow a delegation with a second agent.
import { asksForCoverage, asksForSubfolders, coverage, joinFolder } from '../checks.js';
import { type Section } from '../contextBudget.js';
import { AGENT_RESULT_LABEL, COMBINE_PROMPT, DECISION_MAX_TOKENS, MAX_HANDED_RESULT_CHARS, MAX_REPLANS_PER_TASK, MAX_SUBTASKS, MIN_SUBTASKS, REPLAN_PROMPT, REROUTE_NOTE, ROOT_COMBINE_PROMPT, ROUTING_PROMPT, SubtaskSpec, TaskNode, errorMessage, isRecord, parseSubtasks, routedParts, subtasksSchema, type Decision, type TaskTreeRun, type TaskUnit } from '../taskTree.js';

export async function planSubtasks(run: TaskTreeRun, node: TaskNode, systemPrompt: string, minItems: number, extra: Section[]): Promise<SubtaskSpec[]> {
    let data: unknown;
    try {
        const reply = await run.call(node, 'Planning subtasks', systemPrompt, await run.sections(node, [], '', extra), {
            replyTokens: DECISION_MAX_TOKENS,
            jsonSchema: subtasksSchema(minItems),
        });
        data = JSON.parse(reply);
    } catch (error) {
        if (!run.isTaskFailure(error)) {
            throw error;
        }
        return [];
    }
    // Subtasks not run yet are about to be replaced, so only the rest of the tree counts as existing work.
    const replaced = new Set(node.children.filter((child) => child.status === 'pending'));
    const existing = run.tree
        .nodes()
        .filter((task) => !replaced.has(task))
        .map((task) => task.prompt);
    const firstNumber = node.children.length - replaced.size + 1;
    return parseSubtasks(isRecord(data) ? data.subtasks : null, existing, firstNumber);
}

// Plan the subtasks, then run them.
export async function workSubtasks(run: TaskTreeRun, node: TaskNode, subtasks: SubtaskSpec[], fromSplit = false): Promise<void> {
    run.tree.setChildren(node, subtasks, fromSplit);
    run.publish();
    await run.runSubtasks(node, fromSplit);
}

// Run the subtasks in order, re-plan the rest after one fails, then combine their results.
export async function runSubtasks(run: TaskTreeRun, node: TaskNode, fromSplit: boolean): Promise<void> {
    let index = 0;
    while (index < node.children.length) {
        const child = node.children[index];
        await run.work(child);
        index += 1;
        const remaining = node.children.slice(index);
        // Subtasks made along a listing each cover their own folders, so one failing leaves the others' scope unchanged.
        if (child.status === 'failed' && remaining.length > 0 && node.replans < MAX_REPLANS_PER_TASK && child.unit === null) {
            node.replans += 1;
            const finished = node.children
                .slice(0, index)
                .map((done, position) => `${position + 1}. ${done.prompt} [${done.status}]`)
                .join('\n');
            const replanned = await run.planSubtasks(node, REPLAN_PROMPT, 1, [
                ['Finished subtasks', finished],
                ['Failure', `Subtask ${child.id} failed: ${child.note}`],
                ['Subtasks not run yet', remaining.map((pending) => `- ${pending.prompt}`).join('\n')],
            ]);
            if (replanned.length > 0) {
                run.tree.setChildren(node, replanned, fromSplit);
                run.publish();
            }
        }
    }

    if (node.children.length > 0 && node.children.every((child) => child.unit !== null)) {
        joinUnitResults(node);
        return;
    }
    const results: Section[] = node.children.map((child) => [
        `Result of subtask ${child.id}: ${child.prompt}` + (child.status === 'done' ? '' : ` (${child.status}: ${child.note})`),
        child.result || 'No result.',
    ]);
    const systemPrompt = (node.parent === null ? ROOT_COMBINE_PROMPT : COMBINE_PROMPT) + run.sourceCheck(false);
    let combined: string;
    try {
        combined = await run.call(node, 'Combining', systemPrompt, await run.sections(node, [], '', results));
    } catch (error) {
        if (!run.isTaskFailure(error)) {
            throw error;
        }
        // Results too long to merge in one reply are joined as they are, so the finished work is not lost.
        node.result = node.children.map((child) => `## ${child.prompt}\n\n${child.result || 'No result.'}`).join('\n\n');
        node.note = `The results were joined without merging, because merging them failed (${errorMessage(error)}).`;
        node.status = 'unverified';
        return;
    }
    const [result, problem] = await run.checkAndRevise(node, systemPrompt, combined, [], results);
    node.result = result;
    node.note = problem;
    node.status = problem ? 'unverified' : 'done';
}

// Route once more after an agent's result when the task may still need another agent, and hand the rest to that agent.
export async function followDelegation(run: TaskTreeRun, node: TaskNode, decision: Decision): Promise<void> {
    // A two-hop task routed to one agent stops after the first hop, so an agent run's own task checks what is still needed.
    const unmet = node.status !== 'done' || (node.parent === null && run.agent !== null && decision.routed);
    // A part routed by its parent already has its agent, and the parent re-plans around it.
    if (!unmet || node.agent || run.specialist || run.tree.roomFor(node) < MIN_SUBTASKS) {
        return;
    }
    const used = decision.agent;
    // Only the agents not used yet are offered, so the task cannot go back to the same one.
    const agentNames = run.agentChoices().filter((name) => name !== used);
    if (agentNames.length === 0) {
        return;
    }
    const extra: Section[] = [[`${AGENT_RESULT_LABEL} ${used} agent`, node.result.slice(0, MAX_HANDED_RESULT_CHARS) || 'No result.']];
    const reply = await run.routingCall(node, ROUTING_PROMPT + REROUTE_NOTE, false, agentNames, extra);
    let data: unknown;
    try {
        data = reply === null ? null : JSON.parse(reply);
    } catch {
        return;
    }
    const parts = routedParts(data, node, agentNames);
    const [next] = parts?.entries() ?? [];
    if (next === undefined) {
        return;
    }
    const [agent, part] = next;
    // The finished hand-over becomes the first subtask, so the second agent sees its result and the combine step joins both.
    const [first] = run.tree.setChildren(node, [
        { prompt: `What the ${used} agent found or did for this task`, deliverable: node.deliverable, depends_on: [], agent: used },
        { prompt: `${part} (for the ${agent} agent)`, deliverable: part, depends_on: [1], agent },
    ]);
    first.approach = 'delegate';
    first.status = node.status;
    first.result = node.result;
    first.note = node.note;
    node.approach = 'decompose';
    node.status = 'running';
    run.publish();
    await run.runSubtasks(node, false);
}

// ============================================================================
// Splitting along a listing
// ============================================================================

// Say why a task whose request covers every file in a folder tree needs splitting by folder after gathering, or ''.
export function overflowReason(run: TaskTreeRun, node: TaskNode): string {
    const gathered = run.taskListings.get(node.id);
    if (gathered === undefined || !coversFolderTree(node)) {
        return '';
    }
    const unentered = coverage('', gathered.listings, true).unentered.length;
    if (unentered > 0) {
        const limit = gathered.limitReached ? ' before the tool-call limit was reached' : '';
        return `${unentered} subfolder${unentered === 1 ? ' was' : 's were'} listed but never gone through${limit}.`;
    }
    return gathered.resultsCut ? 'The listings were cut to fit the context window.' : '';
}

function coversFolderTree(node: TaskNode): boolean {
    return node.unit !== null ? node.unit.recursive : asksForCoverage(node.prompt) && asksForSubfolders(node.prompt);
}

// Return the folders the task's listings revealed: one unit for the files directly in its folders, one per subfolder.
export function listingUnits(run: TaskTreeRun, node: TaskNode, approach: string, keepListedLeaves: boolean): TaskUnit[] {
    const gathered = run.taskListings.get(node.id);
    if (gathered === undefined || !coversFolderTree(node)) {
        return [];
    }
    // Research would search the web for a folder's name, so a folder is read with the file tools instead.
    const unitApproach = approach === 'act' ? 'act' : 'files';
    const folders = new Map(gathered.listings.filter((listing) => listing.tool === 'list_directory').map((listing) => [listing.path, listing]));
    const flat: string[] = [];
    const deep: string[] = [];
    for (const scope of node.unit?.paths ?? ['.']) {
        const listing = folders.get(scope);
        if (listing === undefined) {
            continue;
        }
        if (listing.entries.some((entry) => !entry.folder)) {
            flat.push(scope);
        }
        for (const entry of listing.entries.filter((found) => found.folder)) {
            const path = joinFolder(scope, entry.name);
            const inside = folders.get(path);
            // A subfolder already listed whole, with no folders of its own, goes with the top files instead of costing a subtask.
            if (keepListedLeaves && inside !== undefined && !inside.entries.some((found) => found.folder)) {
                flat.push(path);
            } else {
                deep.push(path);
            }
        }
    }
    const units: TaskUnit[] = flat.length > 0 ? [{ paths: flat, recursive: false, approach: unitApproach }] : [];
    return [...units, ...deep.map((path): TaskUnit => ({ paths: [path], recursive: true, approach: unitApproach }))];
}

// Fit the units into the subtasks the budget allows, putting neighbouring folders together when there are too many.
function batchUnits(units: TaskUnit[], room: number): TaskUnit[] {
    if (units.length <= room) {
        return units;
    }
    const flat = units.filter((unit) => !unit.recursive);
    const deep = units.filter((unit) => unit.recursive);
    const slots = room - flat.length;
    const size = Math.ceil(deep.length / slots);
    const batches: TaskUnit[] = [];
    for (let start = 0; start < deep.length; start += size) {
        const group = deep.slice(start, start + size);
        batches.push({ paths: group.flatMap((unit) => unit.paths), recursive: true, approach: group[0].approach });
    }
    return [...flat, ...batches];
}

function folderNames(paths: string[]): string {
    const names = paths.map((path) => (path === '.' ? 'the top folder' : `"${path}"`));
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function unitSpec(unit: TaskUnit): SubtaskSpec {
    const where = folderNames(unit.paths);
    const one = unit.paths.length === 1;
    // The request's own task is named first, since a part told only to "cover" its files lists them without doing the task.
    const prompt = unit.recursive
        ? `Do what the original request asks for every file in ${where} and in every subfolder inside ${one ? 'it' : 'them'}: list ${one ? 'it' : 'each'} with list_directory, then each subfolder listed, and name each file in the answer.`
        : `Do what the original request asks for every file directly in ${where}: list ${one ? 'it' : 'each'} with list_directory, name each file in the answer, and leave the subfolders to the other subtasks.`;
    const deliverable = `The original request done for every file in ${where}${unit.recursive ? ' and below' : ''}, each file named`;
    return { prompt, deliverable, depends_on: [], unit };
}

function unitHeading(unit: TaskUnit): string {
    const where = folderNames(unit.paths);
    return unit.recursive ? `Files in ${where} and below` : `Files directly in ${where}`;
}

// Split a task into one subtask per unit its listings revealed, within the node budget; return whether it split.
export async function splitAlongListing(run: TaskTreeRun, node: TaskNode, units: TaskUnit[], reason: string): Promise<boolean> {
    const room = Math.min(MAX_SUBTASKS, run.tree.roomFor(node));
    if (units.length < MIN_SUBTASKS || room < MIN_SUBTASKS || run.specialist) {
        return false;
    }
    const batched = batchUnits(units, room);
    node.approach = 'decompose';
    node.note = `Split by folder: ${reason}`;
    await run.workSubtasks(node, batched.map(unitSpec), true);
    return true;
}

// Join the results of subtasks made along a listing in code, one heading per unit, since a model merging them drops files.
function joinUnitResults(node: TaskNode): void {
    const parts = node.children.map((child) => {
        const outcome = child.status === 'done' ? '' : `\n\n(${child.status}${child.note ? `: ${child.note}` : ''})`;
        return `## ${unitHeading(child.unit!)}\n\n${child.result || 'No result.'}${outcome}`;
    });
    const batched = node.children.filter((child) => child.unit!.recursive && child.unit!.paths.length > 1);
    if (batched.length > 0) {
        const groups = batched.map((child) => folderNames(child.unit!.paths)).join('; ');
        parts.unshift(`Some folders were worked together to stay within the task budget (max_task_nodes, max_task_depth): ${groups}.`);
    }
    node.result = parts.join('\n\n');
    const unfinished = node.children.filter((child) => child.status !== 'done').length;
    node.status = unfinished === 0 ? 'done' : 'unverified';
    node.note = unfinished === 0 ? node.note : `${node.note} ${unfinished} of ${node.children.length} folder parts did not finish cleanly.`.trim();
}
