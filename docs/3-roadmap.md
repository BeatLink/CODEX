# Roadmap

Statuses were checked against the code on 2026-11-06 (see the first section).

## Codebase review: first pass done (2026-11-06)

Status claims in docs 2–3 were checked against `src/`: tables, approaches, daemon methods, window pages, eval assets and the absence of every proposed mechanism (voting, escalation, scratchpad, blueprints, rule engine, model-authored skills, drives) all match. Corrected: the memories table is `user_memory`, `task_runs` was undocumented, and the agents eval assets are on `main`. Still unchecked: behaviour details (e.g. the nested tree display for delegation, validation-error retry, the failure-mode log), which need targeted tests or a live run.

## Then: a fast, trustworthy eval loop

Every open strategic question (doc 2) is settled by eval runs, so this comes before any architecture bet. Speed is fixed (2026-11-06): all 33 layers of the 4B load on the GPU under CUDA, a model call averages ~4 s, and one 16-run round of the agents eval takes ~10 min. The earlier ~30 s calls date from before the 2026-11-05 reboot, when CUDA fell back to the CPU. `--output` now records every run's tool calls (name and arguments) beside its answer. Still to do: benchmark on real maintenance tasks, not only the fixed sets.

## In progress

- Name topics like chat titles, and place renamed topics again during consolidation.
- Conversation titles: built (`core/titles.ts`, doc 1, "Background worker"); only the unfinished-run bar shows them, since there is no list of past conversations yet (see "Conversation archive"). Check a sample of titles from real requests against the request text.

## Agent hierarchy

**Direction (2026-11-06):** the hierarchy stays as the design for scale. Long tasks and projects can be split again and again, and a flat tool list stops working once dozens of servers are connected. Small atomic steps with only the context they need are the part with evidence behind it (MAKER, doc 2), and both runners already have that. What the evals decide is how agents are built (routing, depth, what each agent sees), not whether they exist. The 8-task eval is a baseline and a bug-finder: with 6 servers and 32 tools it cannot show a scaling advantage, so the real test is a scaled task set (next steps 6 and 7).

### Status

- **Prototype landed:** `delegate`, agent files, nested runs (depth ≤ 3), per-agent MCP servers; covered by scripted-model unit tests.
- **Eval built and run** (assets on `main`): see the eval assets in doc 1. Model is Qwen3.5-4B-UD-Q4_K_XL; the 35B was never loaded (file deleted).
- **First full round (2026-11-06, one run each):** `tree` 3/8 tasks (6/14 checks, 83 calls, 356 s); `agents` 0/8 (0/14, 57 calls, 205 s). Rerunning three of the tasks gave `agents` 2/3 and `tree` 1/3, so single rounds swing widely and only repeated rounds count. Three rounds before the fix below: `tree` 4/24 tasks (17%, 171 calls); `agents` 2/24 (8%, 239 calls); a run reached an MCP tool in 5/24 (`tree`) and 2/24 (`agents`).
- **Main failure: the model never reaches the connected tools.** MCP servers are reachable only through the `act` approach, but `decide` was not told which servers are connected, so a question about the user's own data read like a web lookup: `marcus-phone` made no tool calls on either runner and answered from the top task's forced web search (a real plumber of that name); `first-todo` / `tree` ran `list_directory` and four `web_search` calls instead of the to-do tools. Fixed in `e4f4b6d`: `decide` names each connected server and its tools and says a task needing them must choose `act`. Three rounds after it: `tree` 17/24 (71%, 268 calls); `agents` 8/24 (33%, 229 calls); runs reaching an MCP tool 19/24 and 8/24.
- **Delegation fixed (2026-11-06):** a probe showed `decide` naming `comms` in `agent` but choosing `research`, so the agent was dropped. The top-level `decide` now lists the tools behind each agent, and a named offered agent counts as `delegate` (doc 1, "Delegation flow"). Three `agents` rounds at a 4,096-token context (6,144 crashed in cuBLAS while the suspended daemon still held 112 MiB of CUDA context): `main` 3/24 (MCP reached in 3 runs, 206 calls); `main` without `6ae18ec`'s one-sentence `reason` cap 3/24 (4 runs), so the cap is not the cause and stays; with the fix 11/24 (46%, 13 runs, 428 calls). Per task with the fix: `inbox-newest`, `next-meeting`, `first-todo` 3/3; `lisbon-forecast` 2/3; `garage-code`, `marcus-phone`, `priya-last-email`, `free-slot-and-weather` 0/3. The extra calls are the delegation hops.
- **Evidence, listing and routing fixes (2026-11-06):** MCP results count as evidence, listings leave out `.codex`, and a routing call picks the agents a task needs (doc 1). Three rounds at the default 6,144-token context, against `e4f4b6d`'s run at the same size: `tree` 17/24 → **19/24 (79%)**, 247 calls; `agents` 8/24 → **11/24 (46%)**, 305 calls; runs reaching an MCP tool 21/24 and 15/24. Routing fixed its target, `free-slot-and-weather` / `agents` 0/3 → 2/3; `marcus-phone` / `tree` 1/3 → 3/3 (evidence fix). Not measured one fix at a time.
- **Failures left** (from the recorded tool calls):
  - *Routing names no agent for notes and contacts lookups:* `garage-code` (both runners 0/3) lists local directories though the request says "It is in my notes"; `marcus-phone` / `agents` (0/3) runs one `web_search` and stops.
  - *Two hops inside an agent stop after the first:* `priya-last-email` / `agents` finds the contact's address in 2/3 runs but never searches the mail; inside `comms`, routing picks `contacts` alone instead of `contacts` then `mail`.
  - *A run that loops to the tool-call limit:* `next-meeting` / `agents` passed 1/3; the other two made 29–30 model calls, one ending "the tool call limit was reached" after `list_events` had already returned the meeting.

### Next (in order)

1. Fix the three failures left (Status above), each measured with the same three-round run. Command (holds the GPU lock): `flock /run/user/1000/codex-gpu.lock node dist/core/evaluation.js --tasks evals/agents_tasks.json --runners tree,agents --repeat 3 --output <file>`. Start with the `next-meeting` loop: watch one run's steps over the daemon socket (README, "Watching a run") or with the eval probe, since the eval keeps tool calls but not step inputs.
2. ~~Check the forced top-level web search.~~ Kept as is (2026-11-06): most real setups have MCP servers connected, so skipping the search whenever any are would take the "the model can't tell it doesn't know" guard from every ordinary web question; and the tasks it misleads (`marcus-phone`) fail first because no agent or tool was chosen, which routing addresses. Revisit if routed tasks still answer from web results about a namesake.
3. ~~Keep the eval's agent files out of the files the model can list and read.~~ Done: listings leave out `.codex`.
4. **Split by need, not by size** (doc 2, "Splitting by need, not by size"): agent routing as a multiple choice is built (doc 1, "Delegation flow", step 2); measure it on the two-domain tasks (`free-slot-and-weather`, `priya-last-email`; `agents` 0/3 on both) against the plain `decide`; then extend split-on-failure to the tool-call and context limits; use the maximal, lazily planned split for the long-horizon set (step 7).
5. Build what the prototype left out: per-agent memory scope (learned from the agent's episodes) and scratchpad folder under the state directory; checkpoint/resume inside a nested run; show the nested tree in the interfaces; per-agent skills and tool allow lists.
6. **Scaled task set:** 20–30 fake servers, so the flat tool list is genuinely large, and tasks that need three or more servers. This is where flat and agents should part.
7. **Long-horizon task set, MAKER-style:** Towers of Hanoi with N disks worked through the task tree, every step checkable. Measures the per-step error rate, how far the tree scales before `max_task_depth`, `max_task_nodes` and the no-resplit rule stop it, and later what voting adds.

### Validation method and limits

Same task set with the same MCP servers configured **flat** vs **behind agents**. Measure the share of tasks that reach the right tool and finish, with the number of model calls beside it (each hop costs calls). If agents lose at small scale, look at what the extra hop costs and how routing fails, and test again at scale before changing the design.

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
- **Use counts only grow:** long-ago popular topics keep refreshing frequently. Proposed fix: rank by time since last recall instead of a total count, so use keeps an item alive and disuse lets it sink (Generative Agents' recency decay; see doc 2 References). Scoring importance when an item is written is the next step only if decay alone does not fix the ranking.

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
3. **Act with approval:** an approved `draft`/`result` action can carry out a change (send reply via a user-named mail command, file an item, write a note). Approval names the exact change; the executing step runs with `user` trust and only that tool. File changes are staged as a diff and the old file is backed up before applying (doc 2, "Verified self-authored skills", Staged, not written).
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
- `write_file` can rewrite Codex's own instructions: with `allow_file_writes` on it blocks secret files and paths outside the root, but not the working folder's `.codex/` (agents, skills, commands) or `CODEX.md`/`AGENTS.md`, nor `~/.config/codex/` when the root contains it (the default root is the working folder). These load into every later call, so text a fetched page talks the model into writing there persists, event runs included. Fix: `writeFile` (`core/tools.ts`) refuses paths inside `.codex/`, files named `CODEX.md` or `AGENTS.md`, and anything under `configDirectory()`, with a test for each; `/init` writes through the harness, not the tool, so it is unaffected. Cost: the user edits those files by hand.
- Possible tool-call injection, unconfirmed: `textToolCalls` (`core/toolStage.ts`) runs `<tool_call>` text in the model's reply as real calls to known tools, so a user run whose model copies a fetched page containing that text could call a tool the page chose. Event runs are already blocked by the trust taint. Test: a fake page with an embedded `write_file` call, read in a user run; if it fires, accept text calls only before any untrusted text is echoed, or only when the reply is nothing but calls.

## Knowledge store: open work

- Stop the task tree applying a recalled fact about a similarly named thing: it gives the ingest service's port for the query service in about half the seeded recall-not-stored runs. A one-call subject check in the check step caught it in every probe.
- Let the user mark a recalled fact wrong, lowering its confidence and queueing a recheck.
- Back up, export and reset the knowledge store, and delete a single fact or memory from the interfaces.
- Rate-limit background fetches per domain, honour robots.txt, and cap fetches per day.
- Show background job metrics, and how often recalled facts are cited in answers.

## Conversation archive

Design in doc 2 ("Conversation archive"). Not built: episodes are deleted under the store cap and step inputs and tool results are not kept.

1. **Record:** archive every conversation in full (request, clarification, answer, steps with tool calls and results, tree snapshot), outside the store cap; delete one or all before a date, and export. Check that every run, including clarified and resumed ones, survives a restart, and record bytes per conversation over a week.
2. **Browse:** a list of past conversations by title and date in the window, full-text search, and a conversation view (reuses `renderer/taskView.ts`). Then check the conversation titles (In progress) in that list.
3. **Consolidation reads it:** before pruning, merging or superseding a fact or memory, look up the conversations behind it; re-read old conversations when the learning prompt changes. Measured with the seeded prune and contradiction cases in doc 2 against consolidation without the archive. Ties in with Core structure ideas item 6 (memory drift watch).

## Coding and acting tasks

- Patch-based edits and Git diff/status tools.
- A bounded command runner for targeted checks.
- Iterate code changes from verification failures.
- Let an acting task write a whole file without its tool call running past `max_tokens` (the `implement-parse-duration` eval task fails at the token limit).
- Get the working written as equations with "=" so a recompute check can read it, and measure what the check adds on the hard eval set (no recompute check exists in `src/` today).

## Model choice

**Assessment protocol.** Every candidate model is run on the same `dist/` build, under the GPU lock, on two sets with `--repeat 3`: `evals/agents_tasks.json` (`--runners tree,agents`) for tool use, and `evals/reasoning_tasks.json` (`--runners bare,tree`) for reasoning and intelligence. Record pass rate per runner on each set, the tasks passed in only some rounds, model calls and seconds per call. The reasoning set's `bare` score is the model alone; `tree` minus `bare` is what the harness adds. A model that wins on tool use but drops on reasoning is reported as a trade-off, not a win. No model has been run on the reasoning set yet; Qwen3.5-4B goes first as the baseline.

- **To do: Qwen3.5-4B reasoning baseline.** Not run yet. Command (waits for the GPU lock): `flock /run/user/1000/codex-gpu.lock nix develop -c node dist/core/evaluation.js --tasks evals/reasoning_tasks.json --runners bare,tree --repeat 3 --output <file>`. Record the `bare` and `tree` pass rates, the tasks passed in only some rounds, and the date here; every later model is compared against it.

- **Open item:** compare the 4B model's pass rate on the `evals/` tasks against the 35B model's. If the gap is small on the tasks that matter, 4B is good enough here. (The agents eval so far used only the 4B; the 35B file was deleted from `models/`, so it must be re-obtained.)
- **Spark-X2.6-4B vs Qwen3.5-4B** (doc 2, "Alternative models"): first a smoke run, `node dist/core/evaluation.js --tasks evals/agents_tasks.json --runners tree,agents --only inbox-newest --model-path models/Spark-X2.6-4B-Q4_K_M.gguf`, to show it loads, fits on the GPU at 6,144 tokens and makes tool calls the harness can read. Then both models through the assessment protocol above. Compare pass rate per runner, runs reaching an MCP tool, model calls, and seconds per call. Switch only if Spark wins on pass rate across all three rounds; then move its entry to doc 1 and point `models/model.gguf` at it. If it loses, record the result in `docs/done/`.
- **Speed baseline** (doc 2, "Fitting more into the 4 GB GPU"): doc 2 only has the bandwidth estimate (~192 GB/s ÷ 2.91 GB ≈ 65 tok/s ceiling for `Qwen3.5-4B-UD-Q4_K_XL`). Measure real generation tok/s and prompt-processing tok/s for that model fully on the GPU at 6,144 tokens, under the GPU lock after checking who holds it, and record them in doc 2 and doc 1 "Measured limits". It is the baseline every KV cache and weight-quant change is compared against, so run it first.
- **KV cache quantization** (doc 2, "Fitting more into the 4 GB GPU"): pass `experimentalKvCacheKeyType`, `experimentalKvCacheValueType` and `flashAttention: true` to `createContext` in `src/core/model.ts`. Try K/V = q8_0/q8_0 first, then q8_0/q5_0, under the GPU lock. For each, measure the largest context that survives a long prompt (not just one that loads), the reserve `core/autoSize.ts` needs, tok/s, and the agents-eval pass rate against the F16 baseline. Keep a setting only if pass rate holds; then move the entry to doc 1 with the new context ceiling. Run before the Spark comparison, since the headroom decides whether Spark fits fully on the GPU.
- **Escalation path:** design and test routing planning and repeatedly failing steps to Qwen3.5-35B-A3B. Not built.
- **Phi-4-mini / Phi-3.5-mini vs Qwen3.5-4B and Spark-X2.6-4B** (doc 2, "Alternative models"): first a desk review: check the claims there against the model cards, read each GGUF's metadata (architecture, KV heads, size) without loading it, and look for independent BFCL and IFEval figures. Drop Phi-3.5-mini if its KV cache does not fit at 6,144 tokens. For the survivor, the same smoke run as Spark (`--only inbox-newest --model-path <gguf>`) to confirm it loads and makes tool calls `textToolCalls` reads, then the assessment protocol above on the same `dist/` build as the other two. Record the review and result in doc 2; switch only on the same rule as Spark.
- **Reasoning-tuned 4B:** try Phi-4-mini-reasoning (3.8B) on `evals/reasoning_tasks.json` and the logic-heavy tasks in `evals/tasks.json` against Qwen3.5-4B; measure pass rate and latency with its thinking constrained and unconstrained.

## Task-decomposition ideas to evaluate

- **Thinking per stage:** doc 2, "Thinking per stage".
- **Telling the model its limits per task:** doc 2, "Telling the model its limits per task".
- **Voting + red-flag filters** on control-flow calls: doc 2, "Voting and red-flagging".
- **Question-driven decisions:** doc 2, "Question-driven decisions".
- **Step-wise tool routing:** doc 2, "Step-wise tool routing".
- **Alternative plans (tree of thought, lite):** doc 2, "Alternative plans".
- **Corrective sub-plan on step failure:** doc 2, "Corrective sub-plan on step failure".
- **Capped retries and excerpts:** doc 2, "Capped retries and excerpts".
- **Refinement loop within a run:** doc 2, "Refinement loop within a run".
- **Refinement across runs:** doc 2, "Verified self-authored skills" and "Procedural memory and retry feedback".
- **Eval-gated prompt variants:** doc 2, "Eval-gated prompt variants".
- **Scratchpad contract:** doc 2, "Scratchpad contract".

## Mascot

Built: see doc 1, "Mascot emotions". Still open:

1. Try other placements (top bar, an empty workbench, the answer area) once the sidebar one has been lived with.
2. Map more states to moods (clarification waiting, background research, unreachable daemon, cancelling, waking): see doc 2, "Mascot: more moods".
3. Mood from content: one enum-schema call at the end of a run or on an event (doc 2, "Mascot: more moods"). Check by hand on a sample of runs that the mood fits the reply, and time the extra call. Compare with the no-call alternative there (mood computed from drive levels and recent outcomes) once drives exist.

## Persona and conversation (open for debate)

Doc 2, "How should it talk to the user?". Nothing decided; settle the open points there before building.

1. **Decide:** which stages get a persona, whether mood may tint its tone, and how many conversation turns a request sees.
2. **Persona eval:** run `evals/tasks.json` with and without a short persona on the final-answer stage over repeated rounds; keep it only if the pass rate holds, and rate tone by hand.
3. **Follow-up eval:** add two- and three-turn tasks whose later turns need the earlier ones, and measure them with turns carried forward against standalone runs.

## Speech output

1. Browser-only Kokoro (`kokoro-js`) demo feeding `speakVisemes`.
2. Optional Chatterbox server backend for machines with ≥ ~8 GB VRAM.
3. First re-verify licences, versions and memory figures (the research was written from memory).

## Core structure ideas and strategic options

Design, and the open questions each answers, are in doc 2. Each is tested against the built design on the same eval tasks; whichever wins becomes the design, including replacing built parts. The sources are unchecked chats, so each item starts with a cheap test.

1. **Check what exists** (model-authored skills, a failure-mode log, validation-error retry): no code for model-authored skills was found; the other two need a closer read.
2. **Blueprints vs bounded tree vs self-organizing** (doc 2, "Bounded dynamism"): pick one recurring request (e.g. "process my inbox"), hard-code its graph, and compare pass rate and model calls with the same request via `decide`. Then widen to two task sets, known-shape and open-ended, each run under three configurations: a fixed pipeline, the current bounded tree, and a loose mode where the model may create agents and rewrite step prompts. Measure pass rate, the tools each run calls (`--output`), model calls, and wrong facts written to memory. Expected: pipelines win known shapes, the bounded tree wins open-ended ones, the loose mode pollutes memory most; repeated rounds decide. If blueprints win their set, design how requests are matched to blueprints (rules, or one constrained classification call) with `decide` as the fallback.
3. **Fact and rule engine, mail pack first** (doc 2, "Fact and rule engine" and "Domain packs"): add the world model tables and a small rule evaluator; build the mail pack by replacing the hard-coded triage heuristics with a rule module over extracted facts, and extracting commitments from mail. Measure triage accuracy against the current path, the extraction error rate (sample world facts against their source text), and model calls per email. If it holds up, the world model replaces the planned entities and commitments tables (Reactive assistant item 5) and the learned rules (item 4) become rows in `rules`; then add calendar and tasks packs.
4. **Verified skill writing:** build the reflect-then-gate loop. Validate by seeding known failing tasks from `evals/` and checking that (a) a gated skill is saved only when its check passes, (b) a deliberately wrong skill is rejected, (c) with the saved skill the same task passes more often over repeated runs. Measure the pass-rate change and the extra model calls.
5. **Specialist models vs 35B escalation:** measure cold-load time for a ~2–2.5 GB model on the 4 GB GPU (reload is already in `ModelCache`), then compare 4B only, 4B plus a specialist, and 35B-A3B on the same eval tasks (the 35B file must be re-obtained; see Model choice). Report router error rate separately.
6. **Memory drift watch:** the main risk for an always-on loop is a wrong fact entering long-term memory. Track how many learned memories and facts later get `disputed`/`superseded`, and sample stored items against their sources, to see whether grounding checks hold over weeks.
7. **Goals, drives and initiative:** design goals and drives as harness state (doc 2, "Cognitive loop"), each drive owning the idle job it starts, with a change log and elapsed-time inputs; decide who may change them (Nexus's bounds are the starting candidate); and test whether drive-chosen idle work beats the fixed chain (ties in with Reactive assistant item 6). Actions stay bounded by the autonomy ladder (Reactive assistant items 3–4).

## Self-improving domains: mail slice first

Design and rationale in doc 2 ("Self-improving domains"). Build one domain end to end before generalising; mail first, because connectors, triage, drafting and the Inbox's approve/reject signal already exist. Shares work with Core structure ideas item 3 (mail pack) and Reactive assistant items 4 and 6.

1. **Record outcomes:** store each mail event's triage class and draft beside what the user then did (approved, rejected, edited and sent, ignored). This is the success signal and the past-case set.
2. **Mail memory scope:** memories and lessons tagged with the domain, recalled for mail runs beside the shared store.
3. **Mail validators:** non-LLM checks for drafts (recipient and subject match the thread, no date or name absent from the thread) and for triage (class consistent with the learned sender rules).
4. **Reflection job:** reads recent rejected or heavily edited outcomes and proposes one change (rule, instruction line, memory, validator).
5. **Replay gate:** test the proposed change on the stored mail cases against the current setup; keep only if better and nothing that passed breaks, otherwise send to the Inbox. Keep a log of kept changes with score and origin, and a way to roll one back.
6. **Scheduler:** add goal-driven jobs and a per-domain budget beside the reactive and maintenance classes in `core/scheduler.ts`.

**Validation:** over a few weeks of real mail, track triage agreement with the user's actions and draft edit distance, before and after kept changes. Check that a deliberately wrong change is rejected by the replay gate. If mail improves, generalise the shape to calendar and tasks; if it doesn't, find out whether the signal, the reflection or the gate is at fault before adding domains.

## Projects

Design in doc 2 ("Projects above domains"). After the mail slice's outcome recording and scheduler steps, which projects reuse.

1. **Records:** `projects` (goal, metric, status) and project tasks (prompt, deliverable, `depends_on`, due date, status, result), linked to topics, facts and entities by graph edges; created by hand from the interfaces or CLI.
2. **Refuse goals as tasks:** a task needs a checkable deliverable; one without is kept as a goal.
3. **Scheduler:** ready project tasks (dependencies done) become goal-driven jobs; working one is one task-tree run whose result is stored on the task.
4. **Project memory scope:** move the `project` memory store from folder keys to project keys, folder as one optional link.
5. **Model-proposed tasks:** the model suggests a few next tasks into the Inbox; the user accepts, edits or rejects; record those decisions as the project's signal.

**Validation:** first project: fitness, mostly research tasks. Check that ready tasks get worked in idle time without blocking foreground runs, that results are recalled in later project tasks, and the share of proposed tasks the user accepts.

## Housekeeping

- Move every hardcoded prompt (triage, `decide`, consolidation, titles, evaluation and the rest in `src/core/`) out of the code into YAML config files, so a user can edit or replace them without a rebuild. Follow the agent files' layout: shipped defaults, overridden by `~/.config/codex/` and then the working folder's `.codex/`, a file replacing one of the same name.

- Add Mermaid diagrams to doc 1 beside the prose they illustrate: ERDs for the knowledge store tables and the reactive assistant's `events` and `actions`, and flowcharts or sequence diagrams for the processes, the task-tree request flow, agent delegation, the background worker and the data flow. GitHub renders Mermaid in Markdown, so they stay text, diffable and edited in the same commit as the change they describe.

- Purge the removed LM Studio notes (`docs/design/lm-studio-models-and-settings.md`, commits 46b2616 and 538c143) from the public history. Postponed: it rewrites published history.
