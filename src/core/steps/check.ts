// The checking step of a task: check a result against its evidence, and revise it once when it falls short.
import { actionReportProblems, calculationProblems, unbackedClaims, uncitedUrls, unsupportedValues } from '../checks.js';
import { type Section } from '../contextBudget.js';
import { queueUnsupportedClaims } from '../evidence.js';
import { type Recalled } from '../knowledge.js';
import { CHECK_MAX_TOKENS, CHECK_PROMPT, CHECK_SCHEMA, REVISE_NOTE, TaskNode, errorMessage, parseCheck, type TaskTreeRun } from '../taskTree.js';

// Check a result and revise it once when it fails; return the result and any problem left.
export async function checkAndRevise(run: TaskTreeRun, node: TaskNode, systemPrompt: string, result: string, evidence: Section[], results: Section[]): Promise<[string, string]> {
    const problem = await run.check(node, result, [...evidence, ...results]);
    if (!problem) {
        return [result, ''];
    }
    let revised: string;
    try {
        revised = await run.call(
            node,
            'Revising',
            systemPrompt + REVISE_NOTE,
            await run.sections(node, evidence, problem, [['Previous attempt', result], ...results]),
            { pinned: run.pinnedCount(problem) },
        );
    } catch (error) {
        // A failed revision keeps the attempt it was fixing, so the task can still be split or finished.
        if (!run.isTaskFailure(error)) {
            throw error;
        }
        return [result, `${problem} The revision failed (${errorMessage(error)}).`];
    }
    return [revised, await run.check(node, revised, [...evidence, ...results])];
}

// Return what is wrong with a task's result, or an empty string when it delivers.
export async function check(run: TaskTreeRun, node: TaskNode, result: string, evidence: Section[] = []): Promise<string> {
    let reply: string;
    try {
        reply = await run.call(node, 'Checking', CHECK_PROMPT, await run.sections(node, evidence, '', [['Result to check', result]]), {
            pinned: 4,
            replyTokens: CHECK_MAX_TOKENS,
            jsonSchema: CHECK_SCHEMA,
        });
    } catch (error) {
        if (!run.isTaskFailure(error)) {
            throw error;
        }
        return `The check could not run (${errorMessage(error)}), so this result is unverified.`;
    }
    // A malformed verdict cannot say what to fix, so it does not send the task round again.
    const problems = [parseCheck(reply) || ''];
    // Recalled facts carry their source URLs and are offered as evidence, so they count as seen.
    const known = [...run.evidence, ...run.dependencyResults(node).map(([, text]) => text), await run.memoryFor(node)].join('\n');
    problems.push(
        ...uncitedUrls(result, known).map(
            (url) => `The result cites ${url}, which is not in the captured evidence; remove it or say it is unverified.`,
        ),
    );
    // Only researched results are held to their evidence; arithmetic and rewriting produce new numbers.
    const usedTools = run.toolbox.usedTools;
    if (run.localKnowledgeUsed || usedTools.has('web_search') || usedTools.has('web_fetch')) {
        const unsupported = unsupportedValues(result, `${run.userPrompt}\n${known}`);
        queueUnsupportedClaims(run.knowledgeStore, result, unsupported, run.maxPendingResearchJobs, run.userPrompt);
        problems.push(
            ...unsupported.map(
                (value) => `The result states ${value}, which appears in no gathered evidence; remove it or say it could not be verified.`,
            ),
        );
    }
    problems.push(...calculationProblems(result));
    const actions = run.taskActions.get(node.id);
    if (actions !== undefined) {
        problems.push(...actionReportProblems(result, actions));
    } else if (run.canAct) {
        // A task that did not act may still claim changes or passing tests that no action in the run made.
        problems.push(...unbackedClaims(result, run.toolbox.actionLog));
    }
    return problems.filter(Boolean).join(' ');
}
