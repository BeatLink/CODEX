// The deciding step of a task: which approaches are open, which agents may take it, and how the model chose.
import { MAX_AGENT_DEPTH, topLevelAgents } from '../agents.js';
import { CLARIFICATION_NOTE, CONNECTED_TOOLS_NOTE, DECISION_MAX_TOKENS, DECISION_PROMPT, DELEGATE_NOTE, Decision, MIN_SUBTASKS, TaskNode, connectedToolsList, decisionSchema, defaultDecision, parseDecision, type TaskTreeRun } from '../taskTree.js';

export function approachesFor(run: TaskTreeRun, node: TaskNode): string[] {
    let approaches: string[];
    if (run.mode === 'execute' && run.canAct && node.parent === null) {
        // An execute request is there to change things, so its top task acts or splits.
        approaches = ['act'];
    } else {
        approaches = ['answer', 'research', 'files', ...(run.canAct ? ['act'] : [])];
    }
    if (run.tree.roomFor(node) >= MIN_SUBTASKS) {
        approaches.push('decompose');
    }
    if (run.agentChoices().length > 0) {
        approaches.push('delegate');
    }
    return approaches;
}

// Return the agents this run may hand a task to: the top level's own, or the agent's sub-agents.
export function agentChoices(run: TaskTreeRun): string[] {
    if (run.agentDepth >= MAX_AGENT_DEPTH) {
        return [];
    }
    return run.agent === null ? topLevelAgents(run.agents) : [...run.agent.agents];
}

export async function decide(run: TaskTreeRun, node: TaskNode): Promise<Decision> {
    const approaches = run.approachesFor(node);
    const ask = node.parent === null && run.clarification === null && !run.delegated;
    const agentNames = run.agentChoices();
    if (agentNames.length > 0) {
        const routed = await run.route(node, approaches, ask, agentNames);
        if (routed !== null) {
            return run.afterClarification(node, routed, ask);
        }
    }
    let systemPrompt = DECISION_PROMPT + (ask ? CLARIFICATION_NOTE : '');
    // Without the servers' names, a question about the user's own mail or calendar reads like a web lookup.
    const servers = run.mcpServers.filter((server) => server.enabled ?? true);
    if (approaches.includes('act') && servers.length > 0) {
        systemPrompt += CONNECTED_TOOLS_NOTE + ' ' + connectedToolsList(servers) + '.';
    }
    if (agentNames.length > 0) {
        systemPrompt += DELEGATE_NOTE + run.agentList(agentNames);
    }
    let reply: string;
    try {
        reply = await run.call(node, 'Deciding', systemPrompt, await run.sections(node), {
            replyTokens: DECISION_MAX_TOKENS,
            jsonSchema: decisionSchema(approaches, ask, agentNames),
        });
    } catch (error) {
        if (!run.isTaskFailure(error)) {
            throw error;
        }
        // A decision that runs out of room or goes in circles falls back to the default approach instead of ending the run.
        run.report(node, 'Deciding failed, using the default approach');
        return defaultDecision(node);
    }
    const decision = parseDecision(
        reply,
        node,
        approaches,
        run.tree.nodes().map((task) => task.prompt),
        agentNames,
    );
    if (decision === null) {
        return defaultDecision(node);
    }
    if (decision.approach === 'files' && run.mode === 'execute' && run.canAct) {
        // An execute request is there to change things, and acting can read files as well.
        decision.approach = 'act';
    }
    return run.afterClarification(node, decision, ask);
}
