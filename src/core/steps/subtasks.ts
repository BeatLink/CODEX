// The subtask steps of a task: plan subtasks, run them in order, re-plan the rest after a failure, combine, and follow a delegation with a second agent.
import { type Section } from '../contextBudget.js';
import { AGENT_RESULT_LABEL, COMBINE_PROMPT, DECISION_MAX_TOKENS, MAX_HANDED_RESULT_CHARS, MAX_REPLANS_PER_TASK, MIN_SUBTASKS, REPLAN_PROMPT, REROUTE_NOTE, ROOT_COMBINE_PROMPT, ROUTING_PROMPT, SubtaskSpec, TaskNode, errorMessage, isRecord, parseSubtasks, routedParts, subtasksSchema, type Decision, type TaskTreeRun } from '../taskTree.js';

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
        if (child.status === 'failed' && remaining.length > 0 && node.replans < MAX_REPLANS_PER_TASK) {
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
