# Tool calling and delegation review: why the 4B model fails

A code-and-docs review of why the local 4B model fails on tool calling and delegation. Dated 2026-11-07. No new eval runs; every pass rate quoted comes from [the roadmap](../3-roadmap.md).

Each finding carries an importance flag (Critical, High, Medium, Low). Line numbers are at commit `c85e02a`.

## Findings

| # | Importance | Finding | Where | Status |
| --- | --- | --- | --- | --- |
| F1 | Critical | Tool calls run through a text-parsing fallback, not the native path | [toolStage.ts:91](../../src/core/toolStage.ts), [toolStage.ts:217-225](../../src/core/toolStage.ts), [model.ts:64-68](../../src/core/model.ts), [1-architecture.md:181](../1-architecture.md) | fix in progress 2026-11-07 (worktree native-tool-calls) |
| F2 | Critical | The tool loop has no stop discipline | [toolStage.ts:168](../../src/core/toolStage.ts), [taskTree.ts:30](../../src/core/taskTree.ts), [gather.ts:80](../../src/core/steps/gather.ts) | fix in progress 2026-11-07 (worktree tool-loop-routing) |
| F3 | High | `decide` asks a six-way choice from a long prose rulebook | [taskTree.ts:141](../../src/core/taskTree.ts), [2-open-questions-and-approaches.md:29](../2-open-questions-and-approaches.md) | proposed |
| F4 | High | Routing bakes the agent into prose and then routes again | [taskTree.ts:616-643](../../src/core/taskTree.ts) | fix in progress 2026-11-07 (worktree tool-loop-routing) |
| F5 | High | Sequential hops inside a parent agent stop after one | [3-roadmap.md:32](../3-roadmap.md) | fix in progress 2026-11-07 (worktree tool-loop-routing) |
| F6 | High | The eval cannot separate harness, model and noise | [settings.ts:14](../../src/core/settings.ts), [3-roadmap.md:126-140](../3-roadmap.md) | proposed |
| F7 | Medium | The nested run wastes its 6,144-token window | [taskTree.ts:990-997](../../src/core/taskTree.ts), [taskTree.ts:1185](../../src/core/taskTree.ts), [gather.ts:83](../../src/core/steps/gather.ts) | proposed |
| F8 | Medium | Every brief a subagent gets is free prose | [2-open-questions-and-approaches.md:59](../2-open-questions-and-approaches.md) | proposed in doc 2; endorsed |
| D1 | Low | Doc 1 contradicts itself on what the nested run receives | [1-architecture.md:264](../1-architecture.md) | docs fix in progress 2026-11-07 (worktree tool-loop-routing) |
| D2 | Low | Two `docs/done/` files duplicate docs 1 and 3 | [done-agents-eval-report.md](done-agents-eval-report.md), [done-agent-hierarchy.md](done-agent-hierarchy.md) | proposed |
| D3 | Low | No single failure taxonomy exists | [3-roadmap.md:30-33](../3-roadmap.md) | proposed |

### F1. Tool calls run through a text-parsing fallback (Critical)

Every control-flow reply is grammar-forced except the tool loop. Qwen and Spark write `<tool_call>` text, and `textToolCalls` ([toolStage.ts:91](../../src/core/toolStage.ts)) reads it with regexes. The loop only calls it when `completion.tool_calls` is empty ([toolStage.ts:217-225](../../src/core/toolStage.ts)). **Why it matters:** arguments are never validated by construction, so a misspelled key or a wrong type reaches the tool. Before commit `8e7cea8` no tool ran at all ([doc 1](../1-architecture.md), "Lesson already paid for", line 181).

The leading hypothesis for the empty `response.functionCalls` is a syntax mismatch. node-llama-cpp's `QwenChatWrapper` ([node_modules/node-llama-cpp/dist/chatWrappers/QwenChatWrapper.js:72](../../node_modules/node-llama-cpp/dist/chatWrappers/QwenChatWrapper.js)) has a "3.5" variation whose call syntax is a single `<parameter=params>` JSON blob. The model writes one `<parameter=key>` per argument. The Phi-4-mini fix (`PHI_FUNCTION_CALLS`, [model.ts:64-68](../../src/core/model.ts)) shows that a custom template restores native parsing. This hypothesis is untested.

### F2. The tool loop has no stop discipline (Critical)

`toolLoop` ([toolStage.ts:168](../../src/core/toolStage.ts)) never deduplicates an identical call and never tells the model it already has what it needs. `act` gets at least `MIN_ACT_TOOL_CALLS = 8` calls ([taskTree.ts:30](../../src/core/taskTree.ts), used at [gather.ts:80](../../src/core/steps/gather.ts)). **Why it matters:** doc 3 records a `next-meeting` run of 29 to 30 model calls that ended at the tool-call limit after `list_events` had already returned the meeting ([3-roadmap.md:33](../3-roadmap.md)). The floor of 8 was set for file work, not for a single read from a connected tool.

### F3. The decision step is a long prose rulebook (High)

`DECISION_PROMPT` ([taskTree.ts:141](../../src/core/taskTree.ts)) defines six approaches in prose. The two largest recorded gains came from moving a rule into code: naming the connected tools (tree 4/24 to 17/24) and treating a named agent as `delegate` in `parseDecision` (3/24 to 11/24; [3-roadmap.md:28-29](../3-roadmap.md)). Doc 2, "Question-driven decisions", is the generalisation. The evidence supports building it.

### F4. Routing bakes the agent into prose and re-routes (High)

`parseRouting` ([taskTree.ts:616](../../src/core/taskTree.ts)) writes the chosen agent only as `(for the X agent)` in the subtask prompt ([taskTree.ts:636](../../src/core/taskTree.ts)). Each subtask then goes through `decide`, which makes another routing call that can pick a different agent. **Why it matters:** a correct first routing can be lost to a second, weaker one.

### F5. Sequential hops stop after one (High)

Inside `comms`, routing picks `contacts` and delegates, then the run finishes. Nothing asks what is still needed after a delegated result, so `priya-last-email` finds the address in 2 of 3 runs and never reaches `mail` ([3-roadmap.md:32](../3-roadmap.md)).

### F6. The eval cannot separate harness, model and noise (High)

Fixes were measured several at a time ([3-roadmap.md:29](../3-roadmap.md)). Qwen's `agents` score fell from 11/24 to 6/24 between builds with the cause unknown ([3-roadmap.md:140](../3-roadmap.md)). Temperature is 0.1 (`TEMPERATURE`, [settings.ts:14](../../src/core/settings.ts)). The eval output keeps tool calls but not step inputs, and the only score is whether the final answer contains a string. Spark scored 17/24 against Qwen's 6/24 on the same harness, so much of the failure is the model, not the harness.

### F7. The nested run wastes its window (Medium)

In `delegate` and `sections` the brief appears as "Original user request", inside "Current task", and beside the real request under `USER_REQUEST_LABEL` ([taskTree.ts:990-997](../../src/core/taskTree.ts)). The nested `run()` recalls memory against the brief, not the request ([taskTree.ts:1185](../../src/core/taskTree.ts)). Tool schemas already take half the gather budget ([gather.ts:83](../../src/core/steps/gather.ts)). **Why it matters:** the window is 6,144 tokens; repeated text crowds out evidence.

### F8. Briefs are free prose (Medium)

Every brief a subagent gets is prose written by a 4B model. Doc 2, "Briefs a subagent gets" ([line 59](../2-open-questions-and-approaches.md)), already proposes typed slots with an in-request check for named values. This review endorses it.

### D1. Contradiction in doc 1 (Low)

The "Why agents" table row "Nested run receives only the task's prompt, deliverable and dependency results, not the original request" ([line 264](../1-architecture.md)) contradicts Delegation flow step 4 ([line 221](../1-architecture.md)): the user's request now travels with every brief.

### D2. Duplicate done files (Low)

`done-agents-eval-report.md` says the agents eval is "not yet run to completion" (line 14) and repeats docs 1 and 3. `done-agent-hierarchy.md` repeats doc 1's Agent hierarchy section.

### D3. No failure taxonomy (Low)

Doc 3's "Failures left" bullets are the start of one. Without a table of symptom, recorded cause, fix commit and measured effect, a regression like 11/24 to 6/24 cannot be explained.

## Proposals

In priority order.

1. Restore native tool calls (F1, Critical), then add step-wise tool routing (route enum plus a per-tool argument grammar, doc 2) where native parsing still fails.
2. Add stop discipline to the loop (F2, Critical): a cached result for a repeated identical call with an "answer now" note, `tool_choice: none` after a successful connected call when nothing new is requested, and no 8-call floor for specialists.
3. Make routing follow through in code (F4, F5, High): carry the agent on the subtask so there is no second routing call, and allow one re-route after a delegated result that does not meet the deliverable.
4. Build question-driven `decide` behind a setting and A/B it on the agents eval (F3, High).
5. Add typed briefs with the in-request value check (F8, Medium).
6. Slim the nested run's context (F7, Medium).
7. Harden the eval (F6, High): temperature 0 for evals, one fix per three-round run, full per-step transcripts in the output file, and per-step metrics (right agent routed, right tool called, valid arguments) as the headline number. Run the reasoning set so the Spark switch can be decided.

## Documentation issues

- D1: the contradiction in doc 1 above. Fix in progress.
- D2: reduce `done-agents-eval-report.md` and `done-agent-hierarchy.md` to a pointer or archive them.
- D3: add a failure taxonomy table to doc 3.

## Method and limits

Read of `src/` and `docs/` at commit `c85e02a`. No model runs. Pass rates quoted are from `docs/3-roadmap.md` and were not re-measured. The F1 cause is a hypothesis from reading the wrapper source, not a confirmed trace. Status entries describe work in sibling worktrees as of 2026-11-07 and were not inspected here.
