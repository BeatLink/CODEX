// The writing step of a task worked directly: gather, write, check, and split it when one step could not finish.
import { coverageProblems } from '../checks.js';
import { taskCoverage } from './check.js';
import { listingUnits, overflowReason, splitAlongListing } from './subtasks.js';
import { Decision, MIN_SUBTASKS, ROOT_WRITE_PROMPT, SEARCH_LABELS, SPLIT_PROMPT, TaskNode, WRITE_PROMPT, errorMessage, type TaskTreeRun } from '../taskTree.js';

// Gather what the task needs, write its result, and check it; split the task when that fails.
export async function workDirectly(run: TaskTreeRun, node: TaskNode, decision: Decision): Promise<void> {
    const evidence = await run.gather(node, decision);
    // A folder tree deeper than one gather could cover is split by folder before anything is written.
    const overflow = overflowReason(run, node);
    if (overflow) {
        const units = listingUnits(run, node, decision.approach, !run.taskListings.get(node.id)!.resultsCut);
        if (await splitAlongListing(run, node, units, overflow)) {
            return;
        }
    }
    const searched = evidence.some(([label]) => SEARCH_LABELS.some((prefix) => label.startsWith(prefix)));
    const systemPrompt = (node.parent === null ? ROOT_WRITE_PROMPT : WRITE_PROMPT) + run.sourceCheck(searched);
    let result = '';
    let problem = '';
    let written: string | null = null;
    try {
        written = await run.call(node, 'Writing', systemPrompt, await run.sections(node, evidence));
    } catch (error) {
        // A task too big to write in one reply can still be split into smaller ones.
        if (!run.isTaskFailure(error) || node.fromSplit || run.specialist || run.tree.roomFor(node) < MIN_SUBTASKS) {
            throw error;
        }
        problem = `Writing the whole task in one reply failed (${errorMessage(error)}).`;
    }
    if (written !== null) {
        [result, problem] = await run.checkAndRevise(node, systemPrompt, written, evidence, []);
    }
    const found = problem ? taskCoverage(run, node, result) : null;
    if (found !== null && (found.missing.length > 0 || found.unentered.length > 0)) {
        // A result that still leaves out listed files is split by folder, each part small enough to cover in full.
        const units = listingUnits(run, node, decision.approach, false);
        if (await splitAlongListing(run, node, units, coverageProblems(found).join(' '))) {
            return;
        }
    }
    // A specialist's failed part goes back to the run that handed it over, which re-plans around it.
    if (problem && !node.fromSplit && !run.specialist && run.tree.roomFor(node) >= MIN_SUBTASKS) {
        // A task one step could not finish is split into smaller ones and tried again.
        const subtasks = await run.planSubtasks(node, SPLIT_PROMPT, MIN_SUBTASKS, [
            ['Failed attempt', result],
            ['Problem with it', problem],
        ]);
        if (subtasks.length >= MIN_SUBTASKS) {
            node.approach = 'decompose';
            node.note = `Split after a failed attempt: ${problem}`;
            await run.workSubtasks(node, subtasks, true);
            return;
        }
    }
    if (!result) {
        throw new Error(problem);
    }
    node.result = result;
    node.note = problem;
    node.status = problem ? 'unverified' : 'done';
}
