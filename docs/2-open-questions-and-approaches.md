# Open questions and approaches

What might change, and the options. Each approach here is unbuilt (or only prototyped) and sits under the open question it answers, with its idea, rationale, costs and how to test it. When one is built it moves to doc 1 with its rationale; when an eval rejects it, it moves to `docs/done/` with the result. Doc 3 orders the work and links here. Checked 2026-11-06: none of these is built.

## Open strategic questions

Nothing in docs 1–2 is final. These are the largest choices still open; each should be settled by Codex's own evals (doc 3), not by argument.

1. **Who plans the work?** (a) the model, per task, through `decide` (built); (b) deterministic blueprints for known request shapes; (c) a rule engine that picks a blueprint from extracted facts, with the model planning only what no rule covers. Doc 0's method and the core structure ideas favour (b)/(c); the 4B evidence (multi-turn ~35%, long-horizon tasks fail) points the same way. The built design is (a).
2. **Where does reasoning happen?** In model verdicts backed by lexical checks (built), or in explicit facts and rules the model only feeds and phrases (neuro-symbolic). Rules are auditable and don't drift; they cost authoring effort and cover only what someone (or a gated learning step) wrote.
3. **How is memory shaped?** Proposed: keep the evidence layer and add a structured world model of facts with provenance, read by rule modules split by domain and bundled into domain packs (see "Memory layers and domain rule sets"). Open until the mail pack prototype is measured; decide before adding the entities and commitments tables.
4. **Which model, and how many?** One 4B generalist (Qwen3.5-4B, built); a reasoning-tuned 4B for logic nodes (Phi-4-mini-reasoning); specialists swapped from disk; a 35B-A3B escalation; or voting with red-flag filters on the 4B. All unmeasured here.
5. **How does it learn?** Model-extracted memories (built) vs model-authored skills, rules and corrections, each gated by a non-LLM verifier before it is stored.
6. **How autonomous?** The autonomy ladder keeps authority with the user per event class. Goals, drives and initiative are part of the long-range aim; open questions are who may set them and how they are bounded.
7. **What is the unit of improvement?** Proposed: the domain, with cognitive processes as shared job types run per domain and changes kept only when they beat the current setup on that domain's past cases (see "Self-improving domains"). Open until the mail slice shows triage getting measurably better over real mail.
8. **What does the eval loop need first?** Every question above is settled by eval runs, so a fast, trustworthy eval loop comes before any architecture bet. Calls took ~30 s until the 2026-11-05 reboot, when CUDA had fallen back to the CPU; they now average ~4 s (doc 3, "Then: a fast, trustworthy eval loop").

## Who plans the work?

### Blueprints: deterministic task graphs

Hard-coded task graphs for requests whose shape is known (e.g. "process my morning inbox": fetch unread, loop in code, one item plus a strict schema per model call, deterministic summary). The model never plans these; it fills one narrow slot per node. Mail triage and drafting already work this way. Open: whether blueprints become the main way requests are worked, with `decide` as the fallback for requests no blueprint covers, or stay a few special cases (open question 1). A rule engine could choose the blueprint (see "Fact and rule engine").

### Model-planned task graphs

For requests no blueprint fits, the model's first turn emits a JSON task graph of atomic items and the harness executes it item by item. `decide` is a per-task version of this (built).

### Question-driven decisions

`decide` asks the model to pick one of six approaches from a long prompt that defines them all (`DECISION_PROMPT` in `core/taskTree.ts`), with rules such as "must be chosen whenever…" left to the model to apply. It is already partly question-driven: `reason` and `facts_to_check` come before `approach` in the schema, and `parseDecision` turns `answer` into `research` when any fact is listed. Proposed: take this all the way. The schema asks the model a few narrow questions, and code picks the approach from the answers.

```
needs_outside_facts: string[]     the current facts_to_check
needs_user_data:     "" | server  does it need anything a connected tool holds? which?
changes_things:      boolean      does it ask for files to be changed or tests to be run?
reads_local_files:   boolean
matching_agent:      "" | agent   does an agent's description cover this task?
distinct_parts:      string[]     the separate pieces of real work, if more than one
```

Approach chosen in code, first match wins: agent → `delegate`; user data or changes → `act`; local files → `files`; facts → `research`; two or more parts → `decompose`; otherwise `answer`. Settings still limit which approaches are allowed.

- **Why:** a yes/no question about one property is easier for a 4B model than a choice among six with every definition in mind. Each "must be chosen whenever X" becomes a rule in code, not prompt text a small model can drop. Grammar-forced JSON is written in schema order, so each answer sits in front of the model when it writes the next.
- **Rewording alone is not the change:** "Does this task need a tool?" in place of "Select a tool" probably changes little. The gain comes from the separate fields and the rules moving into code.
- **Same idea for tool choice:** the `act` gather prompt could first ask what the task must find out or change and which listed tool does it, so there is a short plan before any tool is called.
- **Costs:** more output tokens per decision (booleans are cheap, lists are not). Answers can contradict each other (e.g. `changes_things` true while the parts only read), which the fixed order resolves.
- **Not built.** Keep `DECISION_PROMPT` behind a setting so the agents eval can compare the two; see doc 3, "Task-decomposition ideas to evaluate".

## Where does reasoning happen?

### Fact and rule engine (neuro-symbolic)

From a design conversation with an LLM assistant (unchecked claims). Problem: datacenter models cost subscriptions and privacy; small local models have stale data and poor reasoning. Proposal: pair the small model with a rule-based expert system, splitting the work.

- **The model is the language layer:** it reads messy input (emails, chat, notes), extracts entities and turns them into structured facts (JSON or logical predicates). It also turns decided outcomes back into prose.
- **The rule engine is the logic layer:** deterministic `IF condition THEN action` rules over those facts, hand-written or updated over time. It does not guess; its decisions are exact and auditable. Facts come from live local data, not the model's training cutoff.
- **Pattern A, model → rules:** model extracts facts from text, the rule engine decides. Gets language understanding without relying on the model's weak multi-step reasoning.
- **Pattern B, rules → model:** an event hits the rule engine first, which decides what must happen; the model only phrases the fixed result ("rewrite these exact outputs as a polite email"), so it cannot invent facts or logic.
- Engines named: CLIPS (and its Python port experta), Drools, or a custom SQL/JSON rule evaluator. For Codex that means a TypeScript or SQL-based evaluator over the SQLite store.

**Where Codex stands:** not built as a general mechanism, but the pieces exist in special cases: mail triage's header heuristics are hard-coded rules; deterministic checks are rules applied to model output; the planned autonomy ladder's learned rules and the overdue sweep for commitments are rule-shaped; the fact store and graph already hold extracted facts. A general fact-and-rule layer could serve all of these, and could also hold drives and goals as inspectable state instead of model-set text.

- **Facts:** structured predicates extracted by the model from text (schema-constrained), plus facts the harness knows directly (event headers, dates, settings, approvals).
- **Rules:** `IF condition THEN action` over those facts, stored as data the user can read and edit, evaluated in TypeScript or SQL over the SQLite store. Rules decide; the model never does in their domain.
- **Two directions:** model → rules (extract facts, rules decide) and rules → model (rules decide, the model only phrases the fixed result).
- **First uses, all rule-shaped already:** mail triage heuristics, the autonomy ladder's learned rules (sender/class → ignore, notify, draft, act), the commitments overdue sweep, choosing a blueprint for a request, and the deterministic checks.
- **Learning rules:** a rule proposed by the model (e.g. from repeated approvals) is stored only behind the verifier gate or the user's approval.

**Store layout.** The engine does not replace the knowledge store. The evidence layer (topics, sources, facts, memories, episodes, FTS5, vectors, graph) stays for recall and grounding. A new **world model** holds the structured facts about the user's world:
- `world_facts`: predicate, arguments (entity ids or values), source (event, episode, source row, or `user`), the source text span, extracting model call, confidence, valid from/to, status (`active`/`retracted`/`superseded`).
- `entities`: people, organisations, threads, projects, with aliases; shared by every domain.
- `rules`: domain, name, conditions, action, priority, origin (`builtin`/`user`/`learned`), enabled, with approvals for learned ones.
- `rule_firings`: which rule fired on which facts and what it did, so every decision traces back to source text.

Rules act only on facts at or above a confidence threshold; below it they propose or ask instead. Rule modules are split by domain and run for their domain's events; cross-domain rules form a separate small module. All modules read one shared world model.

**Engine.** A small forward-chaining evaluator in TypeScript, or Datalog-style recursive queries in SQLite, so the stack stays Node + SQLite (Drools needs a JVM, CLIPS/experta are C/Python).

## How is memory shaped?

### Memory layers and domain rule sets

**The rule engine does not replace the memory store.** Rules always run over a base of facts, so the question is what shape the store takes. Knowledge splits in two:

| Kind | Examples | Fits rules? |
| --- | --- | --- |
| The user's world | people, threads, commitments, deadlines, events, preferences, approvals, goals | Yes: small structured facts, e.g. `commitment(me, send_report, alice, due=2026-11-10, status=open)`, that rules can reason over exactly |
| World knowledge and evidence | research facts, page summaries, sources, episodes, free-text memories | No: prose, found by meaning (search and vectors); forcing it into predicates loses most of its content |

So the store has two layers: the **evidence layer** (today's sources, summaries, facts, episodes, FTS5 and vectors) for recall and grounding, and a **world model** of structured facts, each with a source link, confidence and valid-from/valid-to times, with the rules themselves stored as data beside them. The world model replaces the planned entities and commitments tables and a separate store of learned rules.

**Every structured fact links back to the text it came from.** A 4B model does the extraction, and a rule acting on a wrongly extracted fact is confidently wrong while looking auditable. Rules act only on facts above a confidence threshold, and every decision can be traced back to the source line.

**Rules are split into modules by domain** (mail, calendar, tasks, bookmarks, research upkeep, ...), each small enough to read, unable to clash silently with another, with its own priority, and run only for its domain's events. **The facts are not split:** the same person appears in mail, calendar and tasks, and the most useful rules cross domains (an email saying "let's meet Thursday" becomes a commitment, a calendar entry and pre-meeting research). One shared world model, one rule module per domain, plus a small set of rules that work across domains.

**A domain pack** bundles what is otherwise spread across separate features: the domain's extraction schema (which facts the model pulls from text), its rule module, its blueprints, its agent file (instructions, tools, MCP servers) and its autonomy-ladder settings. The model is then left three narrow jobs: text → facts, decision → prose, and requests no rule covers. This is doc 0's method applied per domain.

### Domain packs

A domain pack is the unit a domain is added as, one folder per domain (global and per working folder, folder wins, like agents and skills):

| Part | Holds |
| --- | --- |
| Extraction schema | The predicates the model extracts from this domain's text, as a JSON schema enforced by grammar |
| Rule module | The domain's rules (also editable in the `rules` table) |
| Blueprints | Fixed task graphs for the domain's recurring requests |
| Agent file | Instructions, tools and MCP servers (see Agent hierarchy) |
| Autonomy settings | Starting rung on the autonomy ladder per event class |
| Memory scope | The domain's own memories and lessons, beside the shared store (see "Self-improving domains") |
| Validators | Non-LLM checks of what correct means here: a draft names the right recipient, a calendar entry doesn't clash |
| Goals | Standing goals that create jobs unprompted, e.g. "no mail awaiting reply older than two days" |
| Success signal | The outcome measured after the fact, e.g. approve/reject, edit distance of a sent draft, tests passing |

Flow for an event: the connector posts it → the pack's extraction call turns its text into world facts (fenced as untrusted, schema-constrained, no tools) → the pack's rules and cross-domain rules fire → each outcome is an action on the ladder, a blueprint run, or, if no rule covers it, a task tree. The model phrases results (drafts, summaries, notifications) from the decided outcome.

First pack: mail, since triage heuristics and drafting exist. Then calendar and tasks, which share people and commitments with mail.

### Scratchpad contract

Each node writes working notes in a grammar-enforced block (`<scratchpad>…</scratchpad>` beside `<output>`, or a `scratchpad` field in the JSON schema). The harness stores the scratchpad with the task and injects it into later nodes that depend on it, as memory scoped to the run. Today only dependency results are passed forward; a per-agent scratchpad folder is proposed below ("Agent hierarchy: not built yet").

From the model-choice conversation ("Alternative models"): the harness extracts only that block, and the grammar enforces it at token level so a stray markdown block cannot break the parser.

## Which model, and how many?

### Model escalation

Default to the 4B model in a fixed harness-owned pipeline. Proposed: escalate planning and steps that fail repeatedly to Qwen3.5-35B-A3B (~3B active parameters). Not built. See doc 1, "Why a 4B model".

### Voting and red-flagging (from MAKER)

Sample a step several times and decide by first-to-ahead-by-K voting; discard confused answers (too long, badly formatted) before they vote and resample. Candidate for control-flow calls (decisions, checks) where replies are schema-constrained and cheap. Not built. Evidence is from one perfectly verifiable domain; test on Codex's own evals before adopting.

### Specialist models

Keep several 1–4B task-specific models on disk (extraction/classification, code, summarisation, a reasoning-tuned model such as Phi-4-mini-reasoning for logic nodes; ~2–2.5 GB each at 4-bit per the chat) and load the right one per task into the 4 GB GPU, unloading after. Built parts that help: `ModelCache` reload, optional separate background model, GPU lock. Missing: a router choosing the model, specialist selection, measured swap latency (the chat says "a fraction of a second to a few seconds"). Constraints: the router must be reliable; the specialist sees only pre-filtered context; a reasoning model's long thinking must be constrained or it costs latency. Compare against "Model escalation" above.

### Alternative models

From a design conversation with an LLM assistant (unchecked claims) about which model suits a harness where the model is a stateless function executor in one node, given fresh context, relevant memories and a scratchpad.

- **Qwen3.5-4B** was recommended: strong instruction following (IFEval), respects boundary tags reliably, a hybrid linear/full-attention design that stays coherent with dense injected context, and the best sub-5B results on code and multi-step micro-logic.
- **Phi-4-mini-reasoning (3.8B)** is the alternative for nodes that do math, symbolic or rigorous multi-hop logic: tuned to reason step by step. The catch: it emits long thinking blocks, adding latency to every round trip unless its output format is constrained. Not tried in Codex.

## How does it learn?

### Verified self-authored skills

A skill is a markdown guide the harness injects into a fresh context when a request matches it (matching exists, by approach).
1. **Attempt:** the task runs normally.
2. **Judge:** the harness decides whether the run was messy or failed, from deterministic signals (tool errors, failed checks, user correction), not from the model's opinion.
3. **Reflect:** the trace is fed back with a prompt asking for a reusable checklist for that kind of request.
4. **Gate:** the draft is saved only if a non-LLM check passes: a generated test run against a sandbox or mock state (`run_tests`), a schema validator, or a deterministic baseline. Generate several, keep those that pass; discard the rest.
5. **Store and retrieve:** save under a skills folder; retrieve by keyword or embedding match against the request.
- Error-driven variant: when schema validation fails on extraction (e.g. a missing `deadline`), ask the model to rewrite its instruction and save the patch, again behind the gate.
- Why the gate: unverified self-generated text drifts ("copy of a copy"), and a wrong skill is injected into every later matching call.

### Procedural memory and retry feedback

- Log each tool/format failure mode to a lessons store and inject it into later prompts for the same tool (partly covered by learned corrections and skill lessons; a failure-mode log specifically is unconfirmed).
- On invalid output, feed the validation error back for one cheap correction turn (current design: grammar-forced JSON, fallbacks, one revise pass).
- Reflection after failure (Reflexion-style): give the model the failure log and ask why the plan failed and what to change; store the answer behind the same verifier gate as skills.

## How autonomous?

### Reactive assistant: target behaviour

An assistant that notices, prepares and asks, and acts alone only where the user has said it may.
- **Many sources, one queue:** mail, calendar, files, timers, webhooks post events; the same queue, scheduler and Inbox serve them.
- **Work shaped like the event:** cheap triage first; a task tree only if needed; result is a draft, filed item, calendar entry or nothing.
- **Autonomy ladder per event class:** approving moves a class up, a rejection moves it down; rules are stored as memories the user can read and delete.
- **Untrusted text never steers:** fenced, read with no tools or the narrowest set, can't widen its own permissions.
- **Model of the user's world:** people, threads, commitments with a lifecycle (open/done/overdue), so "who am I waiting on" and "what did I promise" have answers.
- **Idle time with a purpose:** meeting pre-research, stale-commitment sweep, entity profiles from past requests, daily digest; pruning/consolidation as upkeep, not the main job; budgeted.
- **Always yields to the user:** a foreground request takes the model from any background run within one call.

### Reactive assistant: planned features
- **Approval and autonomy ladder** (observe → notify → draft → act with approval → act unattended; rules learned from approvals/rejections). Until it exists no event run can change anything.
- **Entities and commitments** (as structured facts in the world model, see "Fact and rule engine"), then idle jobs driven by them: pre-research for tomorrow's meetings, stale-commitment sweeps, entity profiles from episodes, daily digest.
- Other connectors: calendar, tasks/to-dos, bookmarks, notes, file watchers, timers, webhooks.
- Mailbox coalescing / backlog policy; rolling thread summaries; idle-work budget.

### Cognitive loop: goals, drives and initiative

The long-range aim (doc 0): perceive → update memory → evaluate goals → plan → act → review feedback, run continuously by the harness. Built parts: connectors and the event queue (perceive), recall and consolidation (memory), the scheduler's priority classes (prioritise), checks (review), idle research (curiosity). Proposed:
- **Goals and drives as harness state:** numeric levels (e.g. curiosity, urgency, upkeep) and a goal list stored in the database, visible and editable by the user, injected into prompts to modulate priority and tone, and readable by rules. The same mood value could drive the mascot and the voice.
- **Initiative:** the scheduler picks idle work from goals and drives instead of a fixed chain (see "Goal-driven idle jobs" in the roadmap).
- **Limits:** whether the model may propose or change goals is open; any change it makes should be gated (user approval or a rule) and every action stays within the autonomy ladder.

**Risks named for an always-on, self-directed loop** (general claims, not measured here):
- **Error cascade:** a hallucination written to long-term memory becomes the agent's reality and compounds over hours or days. Counters in Codex: evidence-grounded facts, expiry, `disputed` marking, untrusted-text fencing. None is a proof against drift, so drift must be measured (roadmap).
- **Own goals / reward hacking:** an agent free to rewrite its sub-goals or drives can satisfy them in ways that violate intent. Self-set goals need limits the model cannot change: for example goals and drives held as harness state the user can read and edit, and actions still bounded by the autonomy ladder.
- **Always-thinking cost:** every inner step is a full forward pass; on one 4 GB GPU shared with foreground work, idle thinking needs a budget.

## What is the unit of improvement?

### Self-improving domains

**Goal.** Codex should not stay a pipeline where a request goes in and an answer comes out. It should get better at its work over time, unprompted.

**What exists and what is missing.** Codex already does work nobody asked for: the scheduler, idle research, consolidation and `learnFromEpisodes`. What it learns is facts. Nothing makes it *better at its job*, because nothing measures how well a job went or changes behaviour in response.

**Why domains.** Each domain (mail, calendar, tasks, research, code) serves one function, so each can have a concrete success signal and a set of past cases to test against. A generic "be better" has neither. Mail triage has approvals and rejections in the Inbox; drafting has how much the user edited the draft; research has whether facts later turn out disputed; code has tests.

**Why the cognitive processes are not copied per domain.** A domain × process grid of agents (a mail planner, a mail auditor, a calendar planner...) means N × 9 agents to maintain, most near-identical. What actually differs per domain is data: memory scope, tools, instructions, validators, goals and success signal. So each process is written once and the scheduler runs it for a domain, which keeps the specialisation without the copies.

**Why one prompt at a time is enough.** One 4B model on a 4 GB GPU behind one lock cannot run agents in parallel; parallel agents would only queue. The scheduler is where initiative lives: it picks the most valuable job next, and goal-driven jobs let a domain start work on its own.

**Why not fully separate domains.** Real requests cross domains, and the same person appears in mail, calendar and tasks. The task tree stays the coordinator and shared memory stays shared.

**Risks:**
- **Self-reinforced errors.** A 4B model reflecting on its own failures can entrench a wrong lesson. Every change is tested on the domain's past cases before it is kept, and stays a readable, removable row.
- **Weak or gamed signals.** Approval rate rises if the system proposes less; edit distance falls if drafts get blander. Each domain needs more than one signal, and the user can see the trend.
- **Too few cases.** A new domain has no history to test against; until it has some, changes go to the Inbox instead of being kept automatically.
- **Idle cost.** Reflection and replay cost model calls on a GPU shared with foreground work; the per-domain budget bounds it.

A domain pack becomes the unit the system gets better at, not only the unit it is configured by.

**Cognitive processes are job types, written once.** Planner, researcher, executor, auditor, pruner, collator and reflection are each one implementation that the scheduler runs *for* a domain: `audit(mail)`, `prune(calendar)`, `research(projects)`. The domain supplies the data (memory scope, tools, instructions, validators, goals, success signal); the process supplies the method. No per-domain copies of the processes.

| Process | Built today as | Per-domain job |
| --- | --- | --- |
| Planner | `decide` / `decompose`, blueprints (proposed) | plans with the domain's blueprints and tools |
| Memory | `recall`, `searchWithMemory` | recalls from the domain's scope plus the shared store |
| Researcher | gather tool loop, `researchOneTopic` | researches topics the domain's goals name |
| Executor | `act`, MCP tools | only the domain's tools, on the autonomy ladder |
| Auditor | `check`, `checks.ts` | the domain's validators, plus re-reading real state after an action |
| Pruner / collator | consolidation, `tidy` | consolidates the domain's memory scope |
| Reflection | `learnFromEpisodes` (generic) | turns recorded outcomes into proposed changes (below) |

**Improvement loop per domain:**
1. **Record:** every run and event outcome is stored with the domain's success signal once it is known (an Inbox approval, the sent text of a draft, a test result).
2. **Reflect:** a reflection job reads recent failures and proposes one change: a rule, an instruction line, a memory, a validator or a skill.
3. **Test:** the change is replayed on that domain's stored past cases (a held-out set kept per domain) against the current setup.
4. **Keep or drop:** kept only if it scores better and breaks no passing case; otherwise dropped, or put in the Inbox for the user to decide. Every kept change is a readable row with its origin, score and date, so it can be rolled back.

Improvements live in data (rules, instructions, memories, validators, skills), never in weights. This is "Verified self-authored skills" and "Refinement across runs" generalised to everything a domain holds, with the domain's past cases as the gate.

**Scheduler.** One model runs one prompt at a time; the scheduler decides which. Jobs come from three sources: reactive (events), goal-driven (a domain's standing goals, checked against the store) and maintenance (research, consolidation, reflection). Priority = urgency × expected value × staleness, with a budget per domain per day so one busy domain cannot starve the rest. A foreground request still pre-empts everything, as today.

**What stays shared.** Requests cross domains ("the email from Sam about Thursday" touches mail, calendar and contacts), so domains are not silos:
- The task tree stays the top-level coordinator: it routes a request to one or more domains and combines their results. Domains nest at most one or two levels; each hand-off loses detail.
- User memory, entities (people, organisations, threads) and the world model are shared; a domain's scope holds only what is specific to it. This matches "Memory layers and domain rule sets" above: facts shared, rule modules per domain.

## Other proposals

### Agent hierarchy: not built yet

- **Per-agent persistence:** a memory scope per agent in the knowledge store, filled by learning from that agent's episodes, plus a scratchpad folder under the state directory.
- **Resume inside an agent:** checkpoints save the delegating task, not the nested run, so a resume restarts the delegation.
- **Show the nested tree** in the interfaces.
- **Per-agent skills and tool allow lists** beyond MCP servers.

### Mascot: more moods

**Not built:** more states mapped to moods. Candidates (state in `src/renderer/runState.ts`): a clarification or approval waiting (`clarifications` not empty; curious), background research working (`backgroundStatus` not `Idle`; focused), daemon unreachable (`connection: 'unavailable'`; worried, today `asleep`), the user cancelling (`cancelling`; startled), resuming from suspend or connecting at launch (waking), a final answer arriving (`phase: 'final'`; excited). Needs a priority order when several hold at once (e.g. worried, asleep, startled, curious, thinking, focused, calm), with happy/sad/excited as brief moments rather than states. The removed CSS mascot also had an antenna pulse while thinking, floating z's while asleep and a slow head bob (git history); RoboEyes draws none of these.

### Speech output

Give the mascot a voice: a TTS engine feeds RoboEyes' `speakVisemes` with real phonemes and durations, and a mood value drives eyes, mouth and voice together. Engine choice and trade-offs follow. Chatterbox would be an optional backend behind a small local server on a machine with enough VRAM; the dev laptop's 4 GB GPU is shared with the main model (see GPU lock), so voice must not compete for it. Not built.

Gathered 2026-11-05 **from memory, not fresh searches**: check licences, versions and memory figures before relying on them.

**Recommendation**
- **Kokoro** (82M params, Apache-2.0) as default: far better than its size suggests, runs on CPU or in the browser (`kokoro-js`, ONNX, WebGPU/WASM), many voices (best in English), ~300 MB at full precision (less quantised), real time or faster on CPU.
- **Piper** for small hardware (e.g. Raspberry Pi): fastest, 15–75 MB per voice, many languages, but flatter and more robotic; newer builds are GPL and each voice has its own licence.
- **Chatterbox** (MIT) when the voice itself must carry emotion: needs a GPU with ~8 GB.

**Others:** StyleTTS2 (MIT) and Orpheus (Apache) are more expressive but heavy/GPU-bound; F5-TTS and XTTS sound very good but have non-commercial weights, so avoid for anything shipped; Bark and Parler are older/slower, no longer the best choice.

**Emotion control:** Kokoro and Piper have none (only voice and speed). Chatterbox: "exaggeration" control and voice cloning from a reference clip. Orpheus: inline tags (`<laugh>`, `<sigh>`), infers tone from text. Dia (Apache): non-verbal tags, GPU-hungry. StyleTTS2: copies a reference clip's style (keep one clip per emotion). Parler-TTS (Apache): voice described in text ("sad, slow, quiet"); flexible, less polished.

**Chatterbox cost:** ~0.5B params, 2–3 GB weights, ~6–8 GB VRAM in the default setup; real time or faster on a recent GPU; on CPU several seconds per sentence (too slow for conversation); needs Python + PyTorch/CUDA so it can't run in the browser and would sit behind a small local server. A ~350M "Turbo" variant exists (availability/memory unchecked). **A 4 GB GPU (the dev laptop) is probably too small** for the standard model at full precision.

**Face integration:** Kokoro and Piper both expose espeak-ng phonemes and timing, so either can feed RoboEyes' `speakVisemes` with real phonemes and durations instead of spelling rules guessing both (Kokoro predicts a duration per phoneme). A mood value could drive eyes, mouth and voice together: with Kokoro only speed and mouth change; with Chatterbox the voice changes too.

## Where these ideas come from

### Prior art: task-decomposition harnesses

Basis: gathered 2026-11-05 as inspiration; not verified beyond the cited sources.

- **MAKER** (Cognizant AI Lab, arXiv 2511.09030): closest match. Split as far as possible so each agent gets one step and only the context it needs; sample each step several times and decide by "first-to-ahead-by-K" voting; "red-flag" confused answers (too long, badly formatted) before they vote, then resample. Ran 1,048,575 Towers of Hanoi steps with zero errors using small non-reasoning models; votes needed grow only logarithmically with step count. Caveat: one domain with a perfectly verifiable step; real coding tasks are harder to split cleanly.
- **EffGen** (arXiv 2602.00887): decomposition on the same small local model; limited sub-agent autonomy; nesting capped at depth 3 (the source of Codex's agent depth limit); sequential chains pass each subtask only its predecessor's output.
- **Recursive decomposition with fresh contexts** (30B-class local models): long context is possible but slow; each sub-task gets a fresh window, scratchpads carry what must persist.
- **Context-Folding** (arXiv 2510.11967): trained agents fold working context (~10× smaller at similar quality). Needs training, so not useful as a harness idea.
- **brainos-orchestrate:** model plans JSON steps, only a capped excerpt of each finished step's output passes forward, a failed step generates a corrective sub-plan.
- **Terminus-4B:** small model post-trained for narrow terminal subtasks as a subagent.
- **Practitioner report** (3B quantized on a Raspberry Pi; anecdotal): ~50% success → 84% with atomic checklist steps; also check real system state instead of trusting the model's report, and cap retries at three.
- **Unverified (from memory only):** Agentless uses a fixed localize → repair → validate pipeline instead of an open agent loop; Aider separates "plan the change" from "write the edit".

**Ideas worth borrowing**, and where Codex stands (per doc 1):
1. Fresh context per step, only the instruction and inputs needed. *Core design.*
2. Cheap redundancy: sample a few times and vote with red-flag filters instead of using a bigger model (small calls are cheap and parallelizable). *Not built.*
3. Verify, don't trust: deterministic test/schema/system check; cap retries; escalate or replan on failure. *Largely built* (deterministic checks, revise-once, re-plan once); escalation to a bigger model not built.
4. Fixed pipeline instead of free-form agent loops; harness drives control flow, model fills narrow slots. *Core design.*
5. Scratchpad or structured state passed between steps. *Partly: dependency results; per-agent scratchpad folder is proposed.*

### Core structure ideas (design conversation)

A design conversation with an LLM assistant about how a harness turns a 4B model into a personal assistant for email, tasks and bookmarks. It is current design input, on equal footing with the built architecture: where the two differ, the question is open (see "Open strategic questions"). **Its claims are the chat model's own, with no checked sources**, and its examples assume a Python stack (Pydantic, vLLM/Ollama); Codex is TypeScript on node-llama-cpp with llama.cpp grammars, which covers the same ground.

| Idea | Why it was argued | Where Codex stands |
| --- | --- | --- |
| **No LLM for the graph:** recurring requests map to fixed task graphs (blueprints), e.g. "process my morning inbox" = fetch unread → loop in code → one email + strict schema per model call | A 4B model drifts when planning a whole workflow; it is best at single-turn, local transformations | **Conflicts with the built design.** Codex lets the model plan each task's split (`decide`) under grammar and size limits; fixed pipelines exist only for mail triage and drafting. The same chat also proposes the model emit a JSON task graph for vague requests ("plan my trip to Chicago"), so the likely answer is both: blueprints where the shape is known, model planning only where it is not |
| Fresh context per atomic task; harness captures structured output, wipes context, logs to storage | Failed calls, stack traces and chatter accumulate and sink long runs | Built |
| Three memory tiers: working state in harness variables, not chat history; episodic/semantic store with top-few retrieval injected before each call; procedural "lessons learned" file injected into later prompts | A 4B model can't hold history; recall must precede the model call | Working state and recall built. Procedural tier partly: `learnFromEpisodes` stores corrections and skills include lessons; a log of each tool's failure modes is not known to exist (verify) |
| Model never runs tools directly; it emits a JSON intent, the harness validates it and on failure feeds the validation error back for one quick correction turn | Small models mangle tool arguments | Grammar-forced JSON, fallbacks and one revise pass are built. Feeding the exact validation error back is not the current mechanism (verify) |
| **The model writes its own skills** (markdown guides): attempt → harness judges the outcome → model reflects on the trace → save `skills/<name>.md` → retrieve by keyword/vector match next time. Error-driven variant: a missed field makes the model rewrite its own extraction instruction | Offloads logic into files the model refines: an "external prefrontal cortex". The model only has to write instructions for itself, read them back and follow them | Skills exist and are matched by approach, not subject. Model-authored skills not confirmed built (verify) |
| A self-written skill or test is trusted only if a non-LLM check passes: code run in a sandbox, a schema validator, a mock-state assertion; generate many, keep the few that pass | Unanchored self-generated data degrades ("copy of a copy", model collapse). The literature concerns training; the same drift applies to stored memory and skills | **Rule for any learned artifact:** a verifier gates the write. Today's learned memories are model-extracted, not verified |
| Teach a model *how to learn* (search, store, retrieve), not facts | Facts go stale on release; weights are a fixed ceiling; external memory scales | This is Codex's goal (doc 0). Pre-training is still needed for language and common sense, so a pre-trained base stays |
| Swap several small specialist models (extraction/classification, code, summarisation; 1–4B, ~2–2.5 GB each at 4-bit) in and out of the 4 GB GPU instead of one large MoE that spills | An MoE's total weights must be resident even when few are active | Not built (see "Specialist models"). Costs: cold-load latency, a router that must not misclassify, specialists naive outside their lane |
| **A cognitive architecture:** the harness re-prompts one core model for each brain function (memory retrieval and storage, gathering input from the environment, reprioritising events, reviewing feedback on outputs, goals, drives, emotions, initiative, metacognition), giving an always-online, always-learning entity that acts on its own | Feasible in principle; "cognitive agent architectures" are an active field. Loop: perceive → update memory → evaluate goals via drives → plan → act → review feedback (Reflexion-style: failure log fed back with "why did this fail, update memory, new strategy") | The long-range aim (doc 0). Built pieces: recall, connectors and event queue, scheduler priorities, checks, consolidation, idle research. Not built: goals, drives, emotions, initiative, a reflection step after failures. Drives in the chat are numeric state injected into prompts (e.g. curiosity, urgency) that modulate tone and priority |

On model choice, the chat objects to the 35B-A3B escalation: an MoE that spills out of 4 GB is the hard case; specialists swapped from disk are the alternative. Neither was measured.

## References

Sources cited by the research behind these docs (not re-verified):

- MAKER: [arXiv 2511.09030](https://arxiv.org/abs/2511.09030), [Cognizant post](https://www.cognizant.com/us/en/ai-lab/blog/maker)
- EffGen: [arXiv 2602.00887](https://arxiv.org/pdf/2602.00887)
- TinyLLM (BFCL on Qwen3-4B): [arXiv 2511.22138](https://arxiv.org/pdf/2511.22138)
- BFCL-V4 Qwen3-4B-Instruct-2507: [benchmarklist](https://benchmarklist.com/models/qwen3-4b-instruct-2507/)
- Enterprise agent benchmark (tau2): [arXiv 2511.08042](https://arxiv.org/pdf/2511.08042)
- Qwen3-4B with grammar-constrained decoding (community guide): [d-central](https://d-central.tech/local-llm-agent-capability/)
- Recursive decomposition with scratchpads: [cyberdagger](https://cyberdagger.com/blog/scratchpads-recursive-decomposition-c2-agent-generation/)
- Context-Folding: [arXiv 2510.11967](https://awesomepapers.io/papers/2510.11967)
- brainos-orchestrate: [decompose.rs](https://docs.rs/crate/brainos-orchestrate/0.5.0/source/src/decompose.rs)
- Terminus-4B: [summary](https://awesomepapers.io/papers/garg2026terminus)
- 3B agent on a Raspberry Pi: [dev.to](https://dev.to/trismegistus/what-3-months-of-running-an-ai-agent-on-a-raspberry-pi-taught-me-about-task-design-1m2l)
- RoboEyes: [github.com/x-tech-laboratories/RoboEyes](https://github.com/x-tech-laboratories/RoboEyes)

