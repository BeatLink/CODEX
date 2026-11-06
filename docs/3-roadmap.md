# Roadmap

Statuses were checked against the code on 2026-11-06 (see the first section).

## Codebase review: first pass done (2026-11-06)

Status claims in docs 2–3 were checked against `src/`: tables, approaches, daemon methods, window pages, eval assets and the absence of every proposed mechanism (voting, escalation, scratchpad, blueprints, rule engine, model-authored skills, drives) all match. Corrected: the memories table is `user_memory`, `task_runs` was undocumented, and the agents eval assets are on `main`. Still unchecked: behaviour details (e.g. the nested tree display for delegation, validation-error retry, the failure-mode log), which need targeted tests or a live run.

## Then: a fast, trustworthy eval loop

Every open strategic question (doc 1) is settled by eval runs, so this comes before any architecture bet. Runs today take ~30 s per model call and whether the model runs on the GPU is unconfirmed (see Agent hierarchy, next steps 1 and 3). Make one eval round cheap enough to repeat, with answers and tool calls saved for every failing run. Then benchmark on real maintenance tasks, not only the fixed sets.

## In progress

- Name topics like chat titles, and place renamed topics again during consolidation.

## Agent hierarchy

**Gate:** the hierarchy is worth keeping only if it beats the flat task tree on tool tasks. Build the items below only after it does; if it doesn't, change or drop the idea.

### Status

- **Prototype landed:** `delegate`, agent files, nested runs (depth ≤ 3), per-agent MCP servers; covered by scripted-model unit tests.
- **Eval built, not run to completion** (assets on `main`): see the eval assets in doc 2. 42 tests pass in `src/core/evaluation.test.ts`.
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

Properties of the code as it stood; record changes against them. Candidate improvements, unprioritized:

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
5. **Entities and commitments:** structured facts in the world model (see Core structure ideas, item 3), filled from mail and user requests, with lifecycle and an overdue sweep as a rule.
6. **Goal-driven idle jobs:** replace the fixed research/index/learn/consolidate chain with jobs chosen by what the store says is stale or upcoming, each with a budget.
7. **More sources:** calendar and a file watcher first (they feed commitments and meeting pre-research).
8. **Upkeep:** prune finished events and old actions; mail settings page; coalesce a large mailbox backlog instead of one message per pass; clean up resumable checkpoints left by stopped event runs.

### Known limits

- One model/lock: events are handled serially; a draft run holds the model for the whole tree, so a foreground request waits until the next stop check, and the event is retried from the start.
- A 6,144-token window can't hold a long thread; only one message body (≤4,000 chars) is used.
- Triage/drafting rely on a small model; the taint limits a fooled model to a wrong summary or poor draft that the user reads first.
- IMAP: one folder per account, new-mail check at most every 2 min, TLS on the given port only (no STARTTLS).

## Knowledge store: open work

- Stop the task tree applying a recalled fact about a similarly named thing: it gives the ingest service's port for the query service in about half the seeded recall-not-stored runs. A one-call subject check in the check step caught it in every probe.
- Let the user mark a recalled fact wrong, lowering its confidence and queueing a recheck.
- Back up, export and reset the knowledge store, and delete a single fact or memory from the interfaces.
- Rate-limit background fetches per domain, honour robots.txt, and cap fetches per day.
- Show background job metrics, and how often recalled facts are cited in answers.

## Coding and acting tasks

- Patch-based edits and Git diff/status tools.
- A bounded command runner for targeted checks.
- Iterate code changes from verification failures.
- Let an acting task write a whole file without its tool call running past `max_tokens` (the `implement-parse-duration` eval task fails at the token limit).
- Get the working written as equations with "=" so a recompute check can read it, and measure what the check adds on the hard eval set (no recompute check exists in `src/` today).
- Refinement loops (scope not recorded in the old TODO; define it).

## Model choice

- **Open item:** compare the 4B model's pass rate on the `evals/` tasks against the 35B model's. If the gap is small on the tasks that matter, 4B is good enough here. (The agents eval so far used only the 4B; the 35B file was deleted from `models/`, so it must be re-obtained.)
- **Escalation path:** design and test routing planning and repeatedly failing steps to Qwen3.5-35B-A3B. Not built.
- **Reasoning-tuned 4B:** try Phi-4-mini-reasoning (3.8B) on logic-heavy eval tasks against Qwen3.5-4B; measure pass rate and latency with its thinking constrained and unconstrained.

## Task-decomposition ideas to evaluate

- **Voting + red-flag filters** on control-flow calls (decide, check): measure whether they improve eval pass rate enough to justify the extra calls (calls are ~30 s each on the dev machine, so cost matters).
- **Corrective sub-plan on step failure** (brainos-style) vs the current "re-plan the rest once": compare.
- **Capped retries** (practitioner: 3) and capped excerpts of step output passed forward: check against the current limits.
- **Scratchpad contract** between steps (doc 2): add a grammar-enforced scratchpad field to task outputs, inject it into dependent tasks, and compare pass rate against dependency results alone. Per-agent scratchpad folder: see Agent hierarchy.

## Mascot

Built: see doc 2, "Mascot emotions". Still open:

1. Try other placements (top bar, an empty workbench, the answer area) once the sidebar one has been lived with.
2. Map more states to moods (clarification waiting, background research, unreachable daemon, cancelling, waking): see doc 2, "Mascot emotions", Not built.

## Speech output

1. Browser-only Kokoro (`kokoro-js`) demo feeding `speakVisemes`.
2. Optional Chatterbox server backend for machines with ≥ ~8 GB VRAM.
3. First re-verify licences, versions and memory figures (the research was written from memory).

## Core structure ideas and strategic options

Design in doc 2 ("Core structure ideas"); the questions they answer are in doc 1 ("Open strategic questions"). Each is tested against the built design on the same eval tasks; whichever wins becomes the design, including replacing built parts. The sources are unchecked chats, so each item starts with a cheap test.

1. **Check what exists** (model-authored skills, a failure-mode log, validation-error retry): no code for model-authored skills was found; the other two need a closer read.
2. **Blueprints vs model planning:** pick one recurring request (e.g. "process my inbox"), hard-code its graph, and compare pass rate and model calls with the same request via `decide`. If blueprints win, design how requests are matched to blueprints (rules, or one constrained classification call) with `decide` as the fallback.
3. **Fact and rule engine, mail pack first** (doc 2, "Fact and rule engine" and "Domain packs"): add the world model tables and a small rule evaluator; build the mail pack by replacing the hard-coded triage heuristics with a rule module over extracted facts, and extracting commitments from mail. Measure triage accuracy against the current path, the extraction error rate (sample world facts against their source text), and model calls per email. If it holds up, the world model replaces the planned entities and commitments tables (Reactive assistant item 5) and the learned rules (item 4) become rows in `rules`; then add calendar and tasks packs.
4. **Verified skill writing:** build the reflect-then-gate loop. Validate by seeding known failing tasks from `evals/` and checking that (a) a gated skill is saved only when its check passes, (b) a deliberately wrong skill is rejected, (c) with the saved skill the same task passes more often over repeated runs. Measure the pass-rate change and the extra model calls.
5. **Specialist models vs 35B escalation:** measure cold-load time for a ~2–2.5 GB model on the 4 GB GPU (reload is already in `ModelCache`), then compare 4B only, 4B plus a specialist, and 35B-A3B on the same eval tasks (the 35B file must be re-obtained; see Model choice). Report router error rate separately.
6. **Memory drift watch:** the main risk for an always-on loop is a wrong fact entering long-term memory. Track how many learned memories and facts later get `disputed`/`superseded`, and sample stored items against their sources, to see whether grounding checks hold over weeks.
7. **Goals, drives and initiative:** design goals and drives as harness state (doc 2, "Cognitive loop"), decide who may change them, and test whether drive-chosen idle work beats the fixed chain (ties in with Reactive assistant item 6). Actions stay bounded by the autonomy ladder (Reactive assistant items 3–4).

## Housekeeping

- Purge the removed LM Studio notes (`docs/design/lm-studio-models-and-settings.md`, commits 46b2616 and 538c143) from the public history. Postponed: it rewrites published history.
