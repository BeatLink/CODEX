# Roadmap

Statuses come from research files only until the codebase review below is done.

## Next: codebase review (later, separate pass)

Review the existing code to find what is already implemented but undocumented, what designs have changed, where the project stands, and what to do next. Then reconcile docs 1–3 and this roadmap.

## Agent hierarchy

<<<<<<< HEAD
Open work, in no fixed order:

1. Per-agent memory scope in the knowledge store, learned from the agent's episodes; scratchpad folder under the state directory.
2. Checkpoint and resume inside a nested run.
3. Show the nested tree in the interfaces.
4. Per-agent skills and tool allow lists.

### Validation

Run `codex eval` on one task set with the same MCP servers configured **flat** vs **behind agents**. Measure the share of tasks that reach the right tool and finish, and the number of model calls beside it (each hop costs calls). If agents do not beat flat on tool choice, the added calls are not worth it, and the feature should be reconsidered.
=======
Sources: `research/done-agent-hierarchy.md`, `research/done-agents-eval-report.md`.

**Gate:** the hierarchy is worth keeping only if it beats the flat task tree on tool tasks. Build the items below only after it does; if it doesn't, change or drop the idea.

### Status

- **Prototype landed:** `delegate`, agent files, nested runs (depth ≤ 3), per-agent MCP servers; covered by scripted-model unit tests.
- **Eval built, not run to completion** (on an unmerged branch at the time of the report; check): see the eval assets in doc 2. 42 tests pass in `src/core/evaluation.test.ts`.
- **Results so far are not a comparison.** `inbox-newest`: first run 0/2 on both runners (`tree` 634 s, `agents` 300 s; cause unknown); second `agents` run 2/2 in 239 s (7 model calls, 314 tokens). Model is Qwen3.5-4B-UD-Q4_K_XL; the 35B was never loaded (file deleted). Runs are slow (~30 s per model call), load average ~15 during the second run, GPU vs CPU use unconfirmed.

### Next (in order)

1. Find out why runs are slow: check loaded `gpu_layers` and whether CUDA is used; rerun when the machine is quiet (no borg backup).
2. Run one round of 16 runs (8 tasks × `tree`, `agents`). If the runners differ, repeat with `--repeat`. Command (holds the GPU lock): `flock /run/user/1000/codex-gpu.lock node dist/core/evaluation.js --tasks evals/agents_tasks.json --runners tree,agents --repeat 3 --output <file>`.
3. Find out why the first run failed: save answers and tool calls for a failing run.
4. If agents win, build what the prototype left out: per-agent memory scope (learned from the agent's episodes) and scratchpad folder under the state directory; checkpoint/resume inside a nested run; show the nested tree in the interfaces; per-agent skills and tool allow lists.

### Validation method and limits

Same task set with the same MCP servers configured **flat** vs **behind agents**. Measure the share of tasks that reach the right tool and finish, with the number of model calls beside it (each hop costs calls). If agents don't beat flat on tool choice, the extra calls aren't worth it.

The tools return canned replies, so the eval measures tool choice and delegation, not real MCP behaviour. Eight tasks and a 4B model give noisy pass rates; any difference needs repeated rounds before it counts.

## Core architecture: known weak points

Source: `research/done-architecture.md`. Properties of the code as it stood; record changes against them. Candidate improvements, unprioritized:

- **Source search is lexical:** the stored-sources lookup before a web search needs shared words (facts/topics already use meaning).
- **Vector search is brute force:** every recall compares against every vector; fine for thousands of facts, slow for millions.
- **Branch routing picks one branch:** recall enters only the most specific named or single closest topic, even for multi-topic questions.
- **Graph is read one step out:** relationships are never followed further or used to find facts.
- **Stale facts are flagged, not retired:** they stay `active` until a newer fact contradicts them.
- **Fact grounding is lexical:** shared words/versions/dates; a paraphrase that changes meaning but keeps words passes.
- **Memories lack embeddings:** differently worded duplicates stay apart.
- **Skills are matched by approach, not subject:** research tasks get research guides whatever the topic; file tasks get code guides even for non-code files.
- **Use counts only grow:** long-ago popular topics keep refreshing frequently.

## Reactive assistant

Sources: `research/done-reactive-assistant.md`, `research/done-reactive-assistant-status.md`.

### Status

All landed and unit-tested with fake models/servers only. **Never tried live:** a real mailbox, a real IMAP server, the real model drafting a reply, or the Inbox in the Electron window (typechecked only). The first live run may show differences.

- Durable `events`/`actions` queues; scheduler with reactive before maintenance; handler registry, `notify`, `post_event`/`events`/`actions`/`resolve_action`.
- Maildir connector + parser; triage (header heuristics, then one schema-constrained call).
- Inbox page, tray entry, desktop notification.
- Trust taint (external runs can't act, write, test, call MCP, fetch pages or read files).
- Events as task trees: `email.draft`, `user.request`.
- IMAP connector (read-only, password from a command; fake-server tests only).
- `queue_request` daemon method (window may call it; no button yet).

Today: mail arrives → automatic mail dropped without the model → rest summarised and ranked → mail awaiting reply gets a drafted reply → all land in the Inbox to read, mark done or dismiss. Nothing is sent; no event run changes anything.

### Remaining work (in order)

1. **Look at it running:** real window + Maildir/IMAP account + real model; check Inbox layout, notification, tray, draft quality and length. Cheapest way to find what tests can't.
2. **Request box in the Inbox:** input for `queue_request` and a way to show a result beside its request.
3. **Act with approval:** an approved `draft`/`result` action can carry out a change (send reply via a user-named mail command, file an item, write a note). Approval names the exact change; the executing step runs with `user` trust and only that tool.
4. **Learned rules:** record approvals/rejections per event class and sender; skip triage for always-ignored senders; promote reliable classes up the ladder.
5. **Entities and commitments:** new tables filled from mail and user requests, with lifecycle and an overdue sweep.
6. **Goal-driven idle jobs:** replace the fixed research/index/learn/consolidate chain with jobs chosen by what the store says is stale or upcoming, each with a budget.
7. **More sources:** calendar and a file watcher first (they feed commitments and meeting pre-research).
8. **Upkeep:** prune finished events and old actions; mail settings page; coalesce a large mailbox backlog instead of one message per pass; clean up resumable checkpoints left by stopped event runs.

### Known limits

- One model/lock: events are handled serially; a draft run holds the model for the whole tree, so a foreground request waits until the next stop check, and the event is retried from the start.
- A 6,144-token window can't hold a long thread; only one message body (≤4,000 chars) is used.
- Triage/drafting rely on a small model; the taint limits a fooled model to a wrong summary or poor draft that the user reads first.
- IMAP: one folder per account, new-mail check at most every 2 min, TLS on the given port only (no STARTTLS).

## Model choice

Source: `research/done-research-4b-model-as-assistant.md`.

- **Open item:** compare the 4B model's pass rate on the `evals/` tasks against the 35B model's. If the gap is small on the tasks that matter, 4B is good enough here. (The agents eval so far used only the 4B; the 35B file was deleted from `models/`, so it must be re-obtained.)
- **Escalation path:** design and test routing planning and repeatedly failing steps to Qwen3.5-35B-A3B. Not built.

## Task-decomposition ideas to evaluate

Source: `research/done-research-task-decomposition-harnesses.md`.

- **Voting + red-flag filters** on control-flow calls (decide, check): measure whether they improve eval pass rate enough to justify the extra calls (calls are ~30 s each on the dev machine, so cost matters).
- **Corrective sub-plan on step failure** (brainos-style) vs the current "re-plan the rest once": compare.
- **Capped retries** (practitioner: 3) and capped excerpts of step output passed forward: check against the current limits.
- **Scratchpad persistence** between steps: see per-agent scratchpad under Agent hierarchy.

## Mascot

Source: `research/done-mascot-emotions.md`.

Built: see doc 2, "Mascot emotions". Still open:

1. Try other placements (top bar, an empty workbench, the answer area) once the sidebar one has been lived with.
2. RoboEyes' white face is hard to see on the light theme's sidebar; decide whether that needs anything.

## Speech output

Source: `research/done-research-open-source-tts.md`.

1. Browser-only Kokoro (`kokoro-js`) demo feeding `speakVisemes`.
2. Optional Chatterbox server backend for machines with ≥ ~8 GB VRAM.
3. First re-verify licences, versions and memory figures (the research was written from memory).

## Founding-conversation ideas

Source: `research/done-core-structure-ideas.md`. Target design is in doc 2; the source is an unverified chat, so each item starts with a cheap test before any build. Not prioritised against the other sections.

1. **Check what exists** (codebase review): model-authored skills, a failure-mode log, validation-error retry.
2. **Verified skill writing:** build the reflect-then-gate loop. Validate by seeding known failing tasks from `evals/` and checking that (a) a gated skill is saved only when its check passes, (b) a deliberately wrong skill is rejected, (c) with the saved skill the same task passes more often over repeated runs. Measure the pass-rate change and the extra model calls (~30 s each on the dev machine).
3. **Blueprints:** pick one recurring request, hard-code its graph, and compare pass rate and calls with the same request via `decide`. Adopt only if it wins.
4. **Specialist models vs 35B escalation:** measure cold-load time for a ~2–2.5 GB model on the 4 GB GPU (reload is already in `ModelCache`), then compare 4B only, 4B plus a specialist, and 35B-A3B on the same eval tasks (the 35B file must be re-obtained; see Model choice). Router error rate must be reported separately.
5. **Memory drift watch:** the chat's main risk for an always-on loop is a wrong fact entering long-term memory. Track how many learned memories and facts later get `disputed`/`superseded`, and sample stored items against their sources, to see whether grounding checks hold over weeks.
6. **Drives/self-set goals:** no work until the autonomy ladder (Reactive assistant, item 3–4) exists; then decide whether numeric drives add anything over the scheduler's priorities.
>>>>>>> d4db434 (Docs restructuring)
