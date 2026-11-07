// The gathering step of a task: look things up in stored knowledge and on the web, then work the tool loop.
import { parseListing, type GatheredListings } from '../checks.js';
import { inputTokenBudget, type Section } from '../contextBudget.js';
import { filesystemNote, formatRecall, isSelfContained, MAX_SEARCH_QUERIES, pageSummarizer, queueStaleTopics, searchQuery, searchWithMemory } from '../evidence.js';
import { type RecalledFact } from '../knowledge.js';
import { runToolStage } from '../toolStage.js';
import { APPROACH_STEPS, Decision, GATHER_PROMPTS, MIN_ACT_TOOL_CALLS, TaskNode, declinedActionsNote, unique, type TaskTreeRun } from '../taskTree.js';

// Look each query up, and say whether stored summaries answered every one of them.
export async function search(run: TaskTreeRun, node: TaskNode, queries: string[]): Promise<[Section[], boolean]> {
    const evidence: Section[] = [];
    let answeredFromMemory = true;
    const shown = new Set((await run.taskRecall(node))[1]);
    for (const query of queries.slice(0, MAX_SEARCH_QUERIES)) {
        let facts: RecalledFact[] = [];
        if (run.knowledgeStore !== null) {
            // A short query matches stored facts that the whole request was too long to match.
            const recalled = await run.knowledgeStore.recall(query, { includeMemories: false });
            facts = recalled.facts.filter((fact) => !shown.has(fact.id));
            queueStaleTopics(run.knowledgeStore, facts, run.maxPendingResearchJobs);
            if (facts.length > 0) {
                for (const fact of facts) {
                    shown.add(fact.id);
                }
                run.recalledFacts = true;
                evidence.push([`Stored facts for '${query}'`, formatRecall({ facts, relationships: recalled.relationships })]);
            }
        }
        run.throwIfStopped();
        const [label, text, fromSummary] = await searchWithMemory(query, run.knowledgeStore, run.toolbox, run.maxPendingResearchJobs);
        evidence.push([`${label} for '${query}'`, text]);
        run.localKnowledgeUsed = run.localKnowledgeUsed || label === 'Local knowledge result';
        // Fresh stored facts were extracted from fetched pages, so they answer a query as a stored summary does.
        answeredFromMemory = answeredFromMemory && (fromSummary || facts.some((fact) => !fact.stale));
    }
    run.evidence.push(...evidence.map(([, text]) => text));
    return [evidence, answeredFromMemory];
}

// Run the task's tools and return what they found, or nothing for a task answered without tools.
export async function gather(run: TaskTreeRun, node: TaskNode, decision: Decision): Promise<Section[]> {
    if (decision.approach === 'answer') {
        // The model cannot tell when it does not know something, so a top-level answer gets one quick search.
        if (node.parent === null && !isSelfContained(run.userPrompt)) {
            return (await run.search(node, [searchQuery(run.userPrompt)]))[0];
        }
        return [];
    }
    let evidence: Section[] = [];
    if (decision.approach === 'research') {
        // The request's own words come first at the top, so a query the model made up is never the only search.
        const ownWords = node.parent === null ? [searchQuery(run.userPrompt)] : [];
        const unique = [...new Set([...ownWords, ...decision.searchQueries])];
        const queries = unique.length > 0 ? unique : [searchQuery(node.prompt)];
        const [found, answeredFromMemory] = await run.search(node, queries);
        evidence = found;
        // Stored page and topic summaries answer on their own, so nothing more is fetched.
        if (answeredFromMemory) {
            return evidence;
        }
    }

    if (decision.approach === 'act' && !(await run.approveActions(node))) {
        const note = declinedActionsNote(run.actionsDecision![1]);
        run.evidence.push(note);
        return [...evidence, ['Action results', note]];
    }
    let systemPrompt = GATHER_PROMPTS[decision.approach] + filesystemNote(run.toolbox, run.allowFileWrites);
    if (decision.approach === 'act') {
        systemPrompt += run.sourceCheck(false) + run.testNote();
    }
    const toolOptions = {
        research: {
            allowedTools: new Set(run.trust === 'user' ? ['web_search', 'web_fetch', 'list_directory', 'read_file'] : ['web_search']),
            pageSummarizer: pageSummarizer(run.llm, run.knowledgeStore, run.maxTokens, run.temperature, run.contextSize),
        },
        files: { allowedTools: new Set(['list_directory', 'read_file']) },
        act: { blockedTools: new Set(['web_search', 'web_fetch']), mcpServers: run.mcpServers },
    }[decision.approach as 'research' | 'files' | 'act'];
    const actionsBefore = run.toolbox.actionLog.length;
    const gathered: GatheredListings = { listings: [], limitReached: false, resultsCut: false };
    // A specialist's part is one narrow lookup or action, so it keeps the configured budget instead of the larger acting one.
    const toolCalls = decision.approach === 'act' && !run.specialist ? Math.max(run.maxToolCalls, MIN_ACT_TOOL_CALLS) : run.maxToolCalls;
    const findings = await run.step(node, APPROACH_STEPS[decision.approach], async (label) => {
        // Half the room goes to the input and half stays free for tool results.
        const budget = Math.floor(inputTokenBudget(run.contextSize, run.maxTokens, run.countTokens, systemPrompt) / 2);
        const userInput = await run.fit(node, await run.sections(node, evidence), budget, 3);
        run.stageInputCallback?.(label, systemPrompt, userInput);
        return runToolStage(run.llm, systemPrompt, userInput, run.toolbox, run.maxTokens, run.temperature, toolCalls, {
            onToken: run.tokenCallbackFor(label),
            contextSize: run.contextSize,
            signal: run.signal ?? undefined,
            onToolCall: run.toolCallCallback === null ? null : (call) => run.toolCallCallback!({ ...call, agent: run.agent?.name ?? null, depth: run.agentDepth }),
            onToolResult: (name, rawArguments, result) => {
                const listing = parseListing(name, rawArguments, result, run.toolbox.root);
                if (listing !== null) {
                    gathered.listings.push(listing);
                }
            },
            onStageEnd: (summary) => {
                gathered.limitReached = summary.limitReached;
                gathered.resultsCut = summary.resultsCut;
            },
            ...toolOptions,
        });
    });
    run.taskListings.set(node.id, gathered);
    if (decision.approach === 'act') {
        run.taskActions.set(node.id, run.toolbox.actionLog.slice(actionsBefore));
    }
    run.evidence.push(findings);
    evidence.push([decision.approach !== 'act' ? 'Findings for this task' : 'Action results', findings]);
    return evidence;
}
