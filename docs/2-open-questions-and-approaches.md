# Open questions and approaches

What might change, and the options. Each approach here is unbuilt (or only prototyped) and sits under the open question it answers, with its idea, rationale, costs and how to test it. When one is built it moves to doc 1 with its rationale; when an eval rejects it, it moves to `docs/done/` with the result. Doc 3 orders the work and links here. Checked 2026-11-06: none of these is built.

## Open strategic questions

Nothing in docs 1–2 is final. These are the largest choices still open; each should be settled by Codex's own evals (doc 3), not by argument.

1. **Who plans the work?** (a) the model, per task, through `decide` (built); (b) deterministic blueprints for known request shapes; (c) a rule engine that picks a blueprint from extracted facts, with the model planning only what no rule covers. Doc 0's method and the core structure ideas favour (b)/(c); the 4B evidence (multi-turn ~35%, long-horizon tasks fail) points the same way. The built design is (a). A fourth option, (d) a self-organizing system where the model creates subtasks and agents, rewrites prompts and prunes its own context, is argued against for a 4B model (see "Bounded dynamism").
2. **Where does reasoning happen?** In model verdicts backed by lexical checks (built), or in explicit facts and rules the model only feeds and phrases (neuro-symbolic). Rules are auditable and don't drift; they cost authoring effort and cover only what someone (or a gated learning step) wrote.
3. **How is memory shaped?** Proposed: keep the evidence layer and add a structured world model of facts with provenance, read by rule modules split by domain and bundled into domain packs (see "Memory layers and domain rule sets"). Open until the mail pack prototype is measured; decide before adding the entities and commitments tables.
4. **Which model, and how many?** One 4B generalist (Qwen3.5-4B, built, or Spark-X2.6-4B in its place); a reasoning-tuned 4B for logic nodes (Phi-4-mini-reasoning); specialists swapped from disk; a 35B-A3B escalation; or voting with red-flag filters on the 4B. All unmeasured here.
5. **How does it learn?** Model-extracted memories (built) vs model-authored skills, rules and corrections, each gated by a non-LLM verifier before it is stored.
6. **How autonomous?** The autonomy ladder keeps authority with the user per event class. Goals, drives and initiative are part of the long-range aim; open questions are who may set them and how they are bounded. A candidate set of bounds, from Nexus, is in "Cognitive loop".
7. **What is the unit of improvement?** Proposed: the domain, with cognitive processes as shared job types run per domain and changes kept only when they beat the current setup on that domain's past cases (see "Self-improving domains"), and projects above domains supplying the goals and tasks they work on ("Projects above domains"). Open until the mail slice shows triage getting measurably better over real mail.
8. **Who is it, and how does it talk?** Today every call gets a task-specific prompt and no identity, and each request is a standalone run with no earlier turns. Proposed for debate: a small user-editable persona (identity, personality, tone) in the stages whose text the user reads, and conversation turns carried between requests, so a long-running assistant talks like one. Open: which stages get the persona, whether drives or mood may tint its tone, and whether the 4B model's accuracy holds with it (see "How should it talk to the user?").
9. **What does the eval loop need first?** Every question above is settled by eval runs, so a fast, trustworthy eval loop comes before any architecture bet. Calls took ~30 s until the 2026-11-05 reboot, when CUDA had fallen back to the CPU; they now average ~4 s (doc 3, "Then: a fast, trustworthy eval loop").

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
- **First rule built (2026-11-06):** a named offered agent wins over the chosen approach, so `agent: "comms"` with `approach: "research"` delegates (doc 1, "Delegation flow"). That alone took the agents eval from 3/24 to 11/24 tasks, which supports moving the other rules into code too. The rest is not built: keep `DECISION_PROMPT` behind a setting so the agents eval can compare the two. **How to test:** run both versions on the same eval tasks over several rounds; eight tasks give noisy pass rates, so one round settles nothing. See doc 3, "Task-decomposition ideas to evaluate".

### Splitting by need, not by size

A 4B model cannot judge in advance whether a task is large, so the harness splits on things it can check.

- **Agent routing as a multiple choice:** built 2026-11-06; see doc 1, "Delegation flow", step 2.
- **Split on failure as the backstop:** a task whose check still fails, or that runs out of tool calls or context, is split instead of answered badly. Partly built: "still failing → split into smaller subtasks" (doc 1); not yet for the tool-call and context limits. **Why:** needs no prediction, at the cost of one wasted attempt.
- **Long tasks split as far as possible (MAKER-style):** for long chains of checkable steps, never ask about size; split until each step is atomic, then add voting and red flags ("Voting and red-flagging"). Plan lazily: the top level plans phases, and each phase is planned only when work reaches it, from the results so far. `max_task_depth`, `max_task_nodes` and the no-resplit rule become budgets a long task can raise, with checkpoints, instead of fixed caps. **Why:** MAKER's million-step result came from maximal splitting with minimal context per step; fixed caps stop a long project however well each step goes. **Open:** whether three levels (`max_task_depth` default 3, settings allow at most 6) are enough. Deeper trees make steps more granular; if each step's state is kept in the knowledge store and the harness (results on the task, scratchpad, recall) rather than in the context passed down the tree, depth costs no context per step, and accuracy holds however long or large the project. **How to test:** the long-horizon task set (doc 3, Agent hierarchy, next step 7) at depths 3, 6 and unbounded, comparing per-step error and whether results from distant branches are still recalled.
- **The other two are not built.** See doc 3, Agent hierarchy, next step 4.

### Step-wise tool routing

In the gather tool loop (`core/toolStage.ts`) one free-form generation sees every allowed tool and picks a tool, writes its arguments and decides whether it is done, all at once. It is the only control-flow step not forced by a grammar, and the reason Qwen's text tool calls need parsing. Proposed: split each tool step into narrow calls.

```
loop (≤ max_tool_calls):
  route:   {reason, tool: enum[allowed tools… | "done"]}   grammar-forced, short tool descriptions only
  fill:    arguments for that tool only                     grammar from that tool's own JSON schema
  execute: harness runs it, fences the result               results go into the next route call
```

- **Not a router that plans every call from the planner's output.** Most chains depend on earlier results (search, then fetch a URL from the results, then read what the page names), so a plan made up front cannot know the arguments; placeholders such as "fetch result 2" would be a small plan language the 4B model must learn, and multi-turn planning is its weakest point (BFCL multi-turn ~22–35%). The router picks only the next step.
- **Why:** the same principle as `decide`: an enum of what is allowed now. Argument filling sees one schema instead of every tool's, and the grammar makes the arguments valid by construction. `done` becomes an explicit choice, so the model can't drift into answering mid-loop. Route and fill errors can be scored separately.
- **Deterministic routing first:** the planner's `search_queries` already go straight to search; tools stay filtered by approach and trust before the router sees them; with one allowed tool the route call is skipped. With many MCP tools, choose the server first and then the tool, which is what agents do (doc 1, "Agent hierarchy"), so routing and the hierarchy are the same idea at two levels and MCP tools probably need only one of them.
- **Costs:** about twice the model calls per tool step, mostly prompt processing on a 6,144-token window.
- **How to test:** add a routed variant of the tool loop (route → fill → execute per step) beside the current one, run both on `evals/agents_tasks.json` with the fake MCP servers, and compare tool-choice accuracy, argument validity, task success and model calls. Score route and fill errors separately.
- **Not built.** See doc 3, "Task-decomposition ideas to evaluate".

### Bounded dynamism: how much the model may decide

The two ends of open question 1: a designed harness where every cognitive step is fixed in code, or a self-organizing system (task decomposition, graph store, rule engine) where the model creates subtasks and agents, refines their prompts and prunes their context. Proposed: neither. The harness owns control flow, and the model gets freedom only where its mistakes can be caught cheaply and deterministically.

**Why not fully dynamic.** Each freedom asks a 4B model for what it does worst (planning over many steps, judging its own output, knowing what it doesn't know), and each fails silently:

| Freedom | How it fails |
| --- | --- |
| Creating subtasks and agents | Errors compound per hop (90% over three hops ≈ 73%); self-written agent descriptions make misrouting worse |
| Rewriting prompts at runtime | An unchecked rewrite steers every later step; a drop in quality can't be traced to prompt or model |
| Pruning its own context | It must predict what it will need later; a pruned fact leaves no error, only a worse answer |
| Writing rules into the rule engine | A wrong rule is a fixed, trusted falsehood, the error cascade made deterministic |

**Why not fully designed.** Fixed pipelines cover only the shapes someone foresaw; open-ended research and decomposition (doc 0's "learn how to learn") need the model to plan.

**The split:**
- **Known shapes:** blueprints. Code loops; the model fills one narrow slot per call.
- **Unknown shapes:** model decomposition inside an envelope: grammar-forced choices, depth and node caps, one re-plan (as `decide` works today, doc 1).
- **Graph store and rules:** held by the harness. The model proposes facts and rules; a non-LLM check gates every write ("Verified self-authored skills").
- **Prompts:** refined across runs, offline and eval-gated, never inside a run ("Eval-gated prompt variants").
- **Pruning:** stays a fixed rule (pin request and current task, condense, then trim; built, doc 1), not a model judgement.

The more of a step the harness can check, the more of it the model may decide. **Test:** doc 3, Core structure ideas, item 2.

### Alternative plans (tree of thought, lite)

At `decide`, sample 2–3 candidate plans and let `check` or a vote pick one, instead of following the single plan with one re-plan on failure. Affordable now that calls take ~4 s. **How to test:** pass rate against the extra calls. Not built.

### Corrective sub-plan on step failure

On a failed step, generate a corrective sub-plan (as brainos-orchestrate does, see "Prior art") instead of the current "re-plan the rest once". **How to test:** compare the two on the same tasks. Not built.

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

### Refinement loop within a run

Replace the task tree's check → revise once → check (`checkAndRevise` in `core/taskTree.ts`) with up to N rounds (start at 3) that stop as soon as the checks pass, each round revising only the requirements that failed. The old Python pipeline had this (commit `60c0bcd`); the TypeScript rewrite kept a single revise. **How to test:** the pass-rate gain against the extra model calls, and whether later rounds fix or only churn. Not built.

### Capped retries and excerpts

The practitioner report ("Prior art") caps retries at three and passes forward only a capped excerpt of each step's output. **How to test:** check the current limits against these. Not built as stated.

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

Each node writes working notes in a grammar-enforced block (`<scratchpad>…</scratchpad>` beside `<output>`, or a `scratchpad` field in the JSON schema). The harness stores the scratchpad with the task and injects it into later nodes that depend on it, as memory scoped to the run. Today only dependency results are passed forward; a per-agent scratchpad folder is proposed below ("Agent hierarchy: not built yet"). **How to test:** add the field to task outputs, inject it into dependent tasks, and compare pass rate against dependency results alone.

From the model-choice conversation ("Alternative models"): the harness extracts only that block, and the grammar enforces it at token level so a stray markdown block cannot break the parser.

**Label evidence by how it was obtained.** Subtask results and page summaries reach the write and combine stages as plain text, looking the same as a quoted source. Proposed: tag each piece of evidence as *quoted* (text from a source or tool result), *summarised* (another step's summary of something this step never saw) or *inferred* (a model conclusion), and tell the write stage to state only quoted evidence as fact. **Why:** Nexus's session log shows a model treating one-line summaries from a sub-call as things it had read itself for four cycles, until it tried to quote them. **How to test:** on `evals/tasks.json`, compare the rate of unsupported claims in final answers with and without the labels.

### Conversation archive

**Today:** a conversation is one request. A finished one is saved as an episode (prompt, title, mode, outline, answer, outcome, tree snapshot), but episodes are working memory: `learnFromEpisodes` reads each once, and once processed they are among the first things deleted when the store passes `background_max_store_megabytes`. Nothing lists past conversations (titles exist, doc 1, "Background worker"), and step inputs and tool results are not kept after a run.

**Idea:** keep every conversation in full in an archive separate from the knowledge store's budget: the request, any clarification and its answer, the answer, the steps with their tool calls and results, the tree snapshot, title and timestamps. The cap no longer deletes it; only the user does (one conversation, or everything before a date). Two uses:

- **The user reads it:** a list of past conversations by title and date in the window, full-text search, and opening one to see the request, answer and steps.
- **The model reads it in idle time:** consolidation and pruning check the archive before acting, instead of deciding from the stored item alone. Before a fact is pruned for never being recalled, look for conversations where the user stated or relied on it; when two facts or memories contradict, look for what the user said about it and when; when the learning prompt changes, re-read older conversations for preferences and corrections the earlier prompt missed. Each lookup is a search, then one schema-constrained call on the excerpt, fenced as untrusted where it holds fetched text.

**Why:** the user gets a record of what was asked and answered, which a memory system that deletes its sources cannot give. Consolidation today judges an item without its origin; the conversation where the user said it is the best evidence of whether a memory is right, and keeping it makes a wrong prune or merge recoverable.

**Costs:** disk (tool results dominate; measure per conversation before deciding whether to cap or compress them); privacy, since the archive keeps what the user typed, secrets included, while `learnFromEpisodes` keeps them out of memory, so it needs delete and export from the start; idle model calls for each archive lookup; and fetched pages in stored tool results are untrusted text that must stay fenced when the model reads them back.

**How to test:** (1) every foreground run, clarification and resumed run appears in the list after a daemon restart, and a run's archived steps match what the socket showed live; record bytes per conversation over a week of real use. (2) Seed conversations where the user states a preference, let the size cap prune the memory learned from it, and check consolidation keeps or restores it from the archive; seed a contradiction and check the newer user statement wins. Measure against consolidation without the archive: memories wrongly pruned or superseded, and model calls per pass.

## Which model, and how many?

### Model escalation

Default to the 4B model in a fixed harness-owned pipeline. Proposed: escalate planning and steps that fail repeatedly to Qwen3.5-35B-A3B (~3B active parameters). Not built. See doc 1, "Why a 4B model".

### Voting and red-flagging (from MAKER)

Sample a step several times and decide by first-to-ahead-by-K voting; discard confused answers (too long, badly formatted) before they vote and resample. Candidate for control-flow calls (decisions, checks; **how to test:** whether it raises eval pass rate enough to justify the extra calls, at ~4 s each on the dev machine's GPU) where replies are schema-constrained and cheap. Not built. Evidence is from one perfectly verifiable domain; test on Codex's own evals before adopting.

### Specialist models

Keep several 1–4B task-specific models on disk (extraction/classification, code, summarisation, a reasoning-tuned model such as Phi-4-mini-reasoning for logic nodes; ~2–2.5 GB each at 4-bit per the chat) and load the right one per task into the 4 GB GPU, unloading after. Built parts that help: `ModelCache` reload, optional separate background model, GPU lock. Missing: a router choosing the model, specialist selection, measured swap latency (the chat says "a fraction of a second to a few seconds"). Constraints: the router must be reliable; the specialist sees only pre-filtered context; a reasoning model's long thinking must be constrained or it costs latency. Compare against "Model escalation" above.

### Alternative models

From a design conversation with an LLM assistant (unchecked claims) about which model suits a harness where the model is a stateless function executor in one node, given fresh context, relevant memories and a scratchpad.

- **Qwen3.5-4B** was recommended: strong instruction following (IFEval), respects boundary tags reliably, a hybrid linear/full-attention design that stays coherent with dense injected context, and the best sub-5B results on code and multi-step micro-logic.
- **Phi-4-mini-reasoning (3.8B)** is the alternative for nodes that do math, symbolic or rigorous multi-hop logic: tuned to reason step by step. The catch: it emits long thinking blocks, adding latency to every round trip unless its output format is constrained. Not tried in Codex.
- **Spark-X2.6-4B** (SparkLLM, Apache 2.0, released 2026-10-21) is a candidate to replace Qwen3.5-4B as the generalist, since it is built as an on-device agent model. Vendor figures only: BFCL-V4 71.8, τ²-bench 86.9, MCP-Atlas 62.4, and a six-category average of 63.3 against Qwen3.5-4B's 43.2; one write-up says instruction following barely moved from Spark-X2.5. No independent BFCL or IFEval comparison with Qwen3.5-4B was found. Tool use over several turns is where Qwen3-4B is weakest (BFCL-V4 ~35.5%, multi-turn 22%), and it is where Spark claims its lead.
  - **Checked without loading it (2026-11-06):** `models/Spark-X2.6-4B-Q4_K_M.gguf` is architecture `spark2_5`, 4.4B parameters, 36 blocks, 3.54 GB, against 2.91 GB for `Qwen3.5-4B-UD-Q4_K_XL`. The `libllama` bundled with node-llama-cpp 3.22 includes `spark2_5`, so no llama.cpp upgrade is needed. `textToolCalls` in `core/toolStage.ts` reads native calls, Qwen's XML form and JSON; Spark writes a fourth form, `<tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>`, which it now reads too. The chat-wrapper settings in `core/model.ts` apply only to Qwen templates.
  - **Risk:** with the 560 MiB reserve in `core/autoSize.ts`, 3.54 GB may not fit entirely on the 4 GB GPU at the 6,144-token context. If it doesn't, it needs fewer GPU layers or a smaller quant, which makes the comparison with Qwen less even. The context ceiling and reserve were fitted to Qwen and must be measured again for Spark.
  - Rejected if it does not beat Qwen3.5-4B on the agents eval (doc 3, "Model choice"). A vendor score alone does not count: a model that invents tool results convincingly can score well and still fail here.

### Thinking per stage

Every call today tells Qwen not to think aloud (`thoughts: 'discourage'` in `core/model.ts`); the only reasoning before a choice is `decide`'s one-sentence `reason`. Proposed: make thinking a per-stage setting with a thought-token budget, off by default, and turn it on only where a stage makes a judgement.

- **Candidates:** `decide` and `Routing` first (which approach, which agents, which subtasks), then `check` (does the answer meet the task) and logic or arithmetic steps. Not for writing, summarising, condensing, triage extraction or tool-argument filling: those are transformations, and MAKER found non-reasoning models enough for atomic steps.
- **Why it might help:** the agents probe found `decide` reasoning its way to "I need to use the comms agent" and still choosing `research`; a model that thinks before the grammar-forced fields may commit to the right one.
- **Costs:** a 4B model can think for hundreds to thousands of tokens, turning a ~4 s call into 10–50 s; thoughts take room in a 4,096–6,144-token window unless dropped after the call; small models loop while thinking (the reason `6ae18ec` added repeat detection).
- **Evidence so far:** removing the 300-character `reason` cap, a cheap stand-in for "think more at `decide`", changed nothing (agents eval 3/24 either way, 2026-11-06).
- **Check before building:** whether node-llama-cpp's thought budget works together with a JSON grammar on the same call.
- **Not built.** See doc 3, "Task-decomposition ideas to evaluate".

### Telling the model its limits per task

No prompt today tells the model what it is working with: the context budget is enforced in `core/contextBudget.ts` and the caps in `core/settings.ts`, but the model never sees them, so it plans and writes as if room were unlimited. Proposed: each stage's prompt states the limits that apply to that call, filled in from the run, and how to work within them.

- **Candidates:** the context left for this call and the reply budget (so `decide` splits work that won't fit, and a writer keeps to its length); the tree caps left (`max_task_depth`, `max_task_nodes`, replans); which tools are connected and that it has no others; that it is a small local model that can't recall facts reliably, so it should look them up or say it doesn't know.
- **Per task, not global:** a stage gets only the limits that change what it should do, so the note stays short in a 4,096–6,144-token window.
- **Risks:** small models may follow a stated limit too literally (refusing or over-splitting) or ignore it; every line added costs context on every call.
- **How to test:** an eval-gated prompt variant ("Eval-gated prompt variants") on the agents eval and a set of tasks that overflow the context, comparing overflow trims, splits and invented facts with and without the note.
- **Not built.** See doc 3, "Task-decomposition ideas to evaluate".

### Fitting more into the 4 GB GPU (VRAM compression)

Research from 2026-11-06 (web sources, mostly blogs, forks and single-model tests; not measured here) on ways to load a larger model or a longer context into the 4 GB GPU. Not built.

**No lossless option fits.** Quantization is lossy compression: it drops precision for good. Lossless weight compression exists (DFloat11 Huffman-codes the BF16 exponent bits to ~70% of the original with bit-identical output; ZipNN and Huff-LLM work the same way), but it applies only to full-precision weights: the 4B at BF16 is ~8 GB, ~5.5 GB lossless, still too big and nearly twice the Q4 file (2.91 GB). Quantized weights are close to random, so entropy coding a Q4 saves only a few percent and the two don't stack. The practical stand-in for lossless is a quant with no measurable loss: Q8_0 (weights or KV cache), with Q6_K close behind.

**Options, cheapest first:**

1. **KV cache quantization (recommended first).** `createContext` in `src/core/model.ts` sets only `contextSize`, so the cache runs at the default F16 and flash attention is off. node-llama-cpp 3.22 exposes `experimentalKvCacheKeyType` / `experimentalKvCacheValueType` (llama.cpp's `-ctk`/`-ctv`); a quantized V cache needs `flashAttention: true`.
   - q8_0 for both roughly halves the cache and is reported near-lossless.
   - q4_0 saves more but loses quality measurably (reports range from +0.2 perplexity to collapsed output similarity on one model). Keys are more sensitive than values; K=q8_0 / V=q5_0 is reported as a sweet spot (community data).
   - Gain: a context past the 6,144-token ceiling, or headroom for a larger model such as Spark-X2.6-4B (3.54 GB). Qwen3.5-4B is hybrid linear/full attention, so only its full-attention layers keep a KV cache and the saving may be smaller than on a pure-attention model.
   - Risk: node-llama-cpp marks both options as unstable and able to crash the process, and llama.cpp aborts on CUDA errors, so test under the GPU lock. The 560 MiB reserve in `core/autoSize.ts` was fitted to an F16 cache and must be measured again.
   - TurboQuant (Google, ICLR 2026; ~3.5 bits per value, ~4.6× K-cache compression, small perplexity loss) exists only in community llama.cpp forks, not mainline or node-llama-cpp.
2. **Lower-bit weight quants.** Builder matters at the same size: on one 27B, Unsloth's `UD-IQ2_XXS` scored perplexity 7.65 against bartowski's `IQ2_XXS` 8.54. IQ3_S on Llama-3-8B is ~0.9 perplexity above FP16; below ~3 bits small models degrade much faster than large ones. "A bigger model at IQ3 beats a smaller one at Q8" is the usual rule, but less reliable for small models making strict tool calls; a 7–9B at IQ2/IQ3 (~2.5–3.5 GB) could just fit and would need its tool-call reliability tested. EXL3 (QTIP trellis quantization) beats GGUF on quality per bit but is ExLlamaV3/Python only, outside Codex's llama.cpp stack.
3. **MoE expert offload** (`--n-cpu-moe`, plus a newer `--moe-cache-mib` expert cache): experts stay in system RAM; attention, shared weights and the KV cache stay on the GPU. One anecdote runs a 35B-A3B on 4 GB with `-ncmoe 999`; another source puts the GPU-resident part of a 35B-A3B at ~10 GB. With ~20 of 27 GiB RAM already in use on the dev laptop, not practical here.
4. **Partial layer offload** (`gpu_layers` below all layers): works with any model, but offloaded layers run at system-RAM speed (see the 9B-on-CPU result in doc 1, "Measured limits").

**Speed.** Single-stream token generation is bound by memory bandwidth, not compute: each token reads every weight once. The RTX 3050 Ti Laptop has ~192 GB/s, so the ceiling is about 192 ÷ model size in GB (~65 tok/s for the 2.91 GB Q4; real speed is lower).

| Setup | Effect on speed |
|---|---|
| Smaller weight quant (Q8 → Q4 → IQ3) | Faster: fewer bytes per token. Unpacking is cheap; IQ quants unpack a little slower than K-quants but stay bandwidth-bound |
| KV cache q8_0 / q4_0 with flash attention | About the same; prompt processing may lose a few percent, and long-context decoding can gain slightly from reading a smaller cache |
| Lossless (DFloat11) | Slower than the same model uncompressed in VRAM (decompression each pass); much faster than offloading |
| Partial layer offload | Much slower, roughly in proportion to the share offloaded |
| MoE expert offload | Slow but workable with enough RAM; only the active experts (~3B of 35B) are read per token |

Anything that keeps the whole model in VRAM keeps it fast; anything that pushes weights to system RAM costs speed. **How to test:** doc 3, "Model choice".

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
- Rejected: letting the model rewrite the harness's own source (Nexus staged such rewrites for the user to apply). Skills give the same "improve yourself" path in a form a gate can check, and a wrong code change breaks every later run, not one kind of request.

### Procedural memory and retry feedback

- Log each tool/format failure mode to a lessons store and inject it into later prompts for the same tool (partly covered by learned corrections and skill lessons; a failure-mode log specifically is unconfirmed).
- On invalid output, feed the validation error back for one cheap correction turn (current design: grammar-forced JSON, fallbacks, one revise pass).
- Reflection after failure (Reflexion-style): give the model the failure log and ask why the plan failed and what to change; store the answer behind the same verifier gate as skills.

### Eval-gated prompt variants

Prompts (`DECISION_PROMPT` and the other step prompts) are refined like code, not by the model mid-run: generate a few variants of one prompt (by hand or by the model, offline), run each on the same eval tasks over repeated rounds, and promote a variant only if it beats the current prompt without breaking a task that passed. Keep the promoted prompt in the repo with its score, so a regression can be traced and rolled back. **Why:** a runtime rewrite is unchecked text every later step obeys ("Bounded dynamism"); an eval gate is the same non-LLM check that guards skills and rules. Same shape as the replay gate in "Self-improving domains", applied to the harness's own prompts instead of a domain's rules. **How to test:** start with `DECISION_PROMPT`; run 2–3 variants against the current one on `evals/agents_tasks.json` and `evals/tasks.json` over three rounds each.

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
- **Goals and drives as harness state:** numeric levels (e.g. curiosity, urgency, upkeep) and a goal list stored in the database, visible and editable by the user, and readable by rules. The same mood value could drive the mascot and the voice.
- **Each drive owns a behaviour:** a drive is a level plus a threshold, a priority, a floor, effects on other drives, and the job it starts when it fires (a job type and its prompt, e.g. curiosity → research a stale topic, upkeep → consolidation). **Why:** Nexus found that a drive which only colours the prompt is "a number to narrate around": the model talks about feeling curious and nothing changes. A drive that cannot start work has no measurable effect.
- **Initiative:** the scheduler picks idle work from the drives that fire and from goals, instead of a fixed chain (see "Goal-driven idle jobs" in the roadmap); the drive's level feeds the urgency term of the scheduler's priority in "Self-improving domains".
- **Elapsed time as input:** drives and goals see wall-clock time, how long since each job type last ran and since the user was last active, so "three days since the last research pass" can raise a drive.
- **Limits:** whether the model may propose or change goals and drives is open; any change it makes should be gated (user approval or a rule) and every action stays within the autonomy ladder. Candidate bounds, from Nexus, which let the model retune its own drives: every value clamped to a range; effects may only name drives that exist; the user's seed drives can be disabled but not deleted; a cap on self-made drives (Nexus: 6); at least one drive always active.
- **Action record, not self-report:** the step that chooses idle work reads the harness's own record of recent jobs and their outcomes, never the model's account of what it did. The same record can become a digest of what Codex did while the user was away. Nexus put such a record at the top of every cycle's prompt, and its model used it to catch and retract its own wrong claims.
- **Change log:** every change to a goal or drive, by the model or the user, is stored with its stated reason, so the record reads as a diff the user can review and revert rather than a silent parameter change.

Not taken from Nexus: inline `REMEMBER:`/`RECALL:` markers in replies (Codex's harness recalls before every call, which suits a 4B model better; a single model-requested recall hop when harness recall finds nothing is a possible later test), and a cloud model transport (against doc 0's local and private aim).

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

**Cognitive processes are job types, written once.** Planner, researcher, executor, auditor, pruner, collator and reflection are each one implementation that the scheduler runs *for* a domain: `audit(mail)`, `prune(calendar)`, `research(projects)`. The domain supplies the data (memory scope, tools, instructions, validators, goals, success signal); the process supplies the method. No per-domain copies of the processes. Already in place: each step of a task is its own record with status and timing (doc 1, "Steps are records") and its own module under `core/steps/`, still run inside one task-tree run.

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

### Projects above domains

Domains say *how* Codex does a kind of work; nothing yet says *why*. Proposed: projects as the top layer, holding the user's goals, the tasks that serve them, and their context. Three separate axes:

| Axis | Answers | Examples |
| --- | --- | --- |
| Projects | why and what: the user's goals, persistent | Fitness, House move, CODEX |
| Domains | how: capabilities with tools, validators, signals | research, mail, calendar, notes |
| Cognitive processes | method: written once, run as jobs | plan, research, audit, prune, reflect |

A project uses domains rather than being one: in a fitness project, "research a diet strategy to lose weight" uses research, "book gym sessions" uses calendar, "log weekly weight" uses notes. Making each project a domain would need tools and validators per project.

**A project is a goal, a persistent task DAG and a context:**
- **Goals are not tasks.** "Lose weight" can never be marked done, so it is a goal with a metric (weight, by when). A task is an atomic item with a checkable output ("research diet strategies → summary with sources"). The harness refuses a goal as a task.
- **Tasks persist.** Today's task tree lives for one request (`task_runs` only checkpoints it for resume). Project tasks are the same nodes made long-lived: status, `depends_on`, due date, result kept. Working one project task is one task-tree run.
- **The scheduler pulls ready tasks.** A task whose dependencies are done is a goal-driven job, which gives "Self-improving domains" and "Cognitive loop" a concrete source of goals.
- **Context is the project's memory scope.** `user_memory` has a `project` store keyed to a folder; keyed to a project instead, "fitness" recalls its findings, constraints and results from any folder.

**Graph: linked, not merged.** The topic hierarchy says what the world is ("nutrition → caloric deficit"); the project hierarchy says what the user wants ("fitness → lose weight → research diet"). Merged, consolidation would re-file goals as world knowledge. Two trees joined by edges: `project —uses→ topic`, `task —produced→ fact`, `task —involves→ person`. Topics are a tree (one `parent_id`); project tasks need a real DAG, since a task can wait on several.

**Who plans.** Breaking a goal into tasks is long-horizon planning, the 4B model's weakest skill (doc 1, "Why a 4B model"). The model proposes a few tasks into the Inbox; the user accepts, edits or rejects them. Those decisions, tasks completed and the goal's metric over time are the project's success signals, beside each domain's.

**Risks:** goal-shaped tasks that never finish; plans that look sensible and lead nowhere (the metric shows it); health and similar project data is sensitive, so it stays in the local store like everything else.

**Not built.** First version: projects as plain records the user creates by hand, worked by the scheduler; model-proposed tasks only once that loop works. See doc 3, "Projects".

## How should it talk to the user?

Open for debate; nothing here is decided. Codex is meant to be a long-running personal assistant (doc 0), not only a request-in, answer-out tool, which argues for a stable voice and for remembering the conversation it is in.

### Persona for user-facing replies

A short persona block, a few sentences naming the assistant and setting its personality and tone, added only to calls whose output the user reads: the final answer (`ROOT_WRITE_PROMPT`, `ROOT_COMBINE_PROMPT`), questions back to the user, notifications and Inbox summaries. Not added to `decide`, routing, research, extraction, triage or checks, where it costs context and adds nothing.
- **Owned by the user:** a file beside the other prompts (see the roadmap's Housekeeping item on moving prompts to config files), shipped with a plain default; the model cannot edit it, matching the limits in "Cognitive loop".
- **Not the user's voice:** drafts written on the user's behalf (mail replies) keep the user's voice, not the persona's.
- **Contrast with Nexus:** Nexus's bootstrap prompt gave the model no identity and asked it to invent one; here the user sets the identity and the model keeps to it.
- **Open:** whether mood or drive levels may tint the tone of a reply (the drives themselves start jobs, not tone; see "Cognitive loop"); how long the block can be before it crowds a 4B model's context.
- **Risk:** personality text can make a small model chattier or less exact, or invent feelings and actions. **How to test:** run `evals/tasks.json` with and without the persona on the final-answer stage over repeated rounds; keep it only if the pass rate holds, and rate tone by hand on a sample.

### Conversational continuity

Each request is a standalone run today; a follow-up such as "and the one before that?" has nothing to refer to except recalled memory. Proposed for debate: the final-answer stage (and `decide`, so a follow-up is planned as one) sees the last few turns of the current conversation, capped by the context budget, with older turns reached through recall and the conversation archive ("Conversation archive"). **Open:** how many turns, whether a turn is passed as text or a short summary, and when a new conversation starts in an always-on assistant. **How to test:** a set of two- and three-turn eval tasks whose later turns cannot be answered without the earlier ones.

## Other proposals

### Agent hierarchy: not built yet

- **Per-agent persistence:** a memory scope per agent in the knowledge store, filled by learning from that agent's episodes, plus a scratchpad folder under the state directory.
- **Resume inside an agent:** checkpoints save the delegating task, not the nested run, so a resume restarts the delegation.
- **Show the nested tree** in the interfaces.
- **Per-agent skills and tool allow lists** beyond MCP servers.

### Mascot: more moods

**Not built:** more states mapped to moods. Candidates (state in `src/renderer/runState.ts`): a clarification or approval waiting (`clarifications` not empty; curious), background research working (`backgroundStatus` not `Idle`; focused), daemon unreachable (`connection: 'unavailable'`; worried, today `asleep`), the user cancelling (`cancelling`; startled), resuming from suspend or connecting at launch (waking), a final answer arriving (`phase: 'final'`; excited). Needs a priority order when several hold at once (e.g. worried, asleep, startled, curious, thinking, focused, calm), with happy/sad/excited as brief moments rather than states. The removed CSS mascot also had an antenna pulse while thinking, floating z's while asleep and a slow head bob (git history); RoboBuddy draws none of these.

**Mood from content, not only run state:** the moods above follow what the harness is doing; none reflects what the conversation says. Proposed: one schema call with an enum of moods at the end of a run, or when an event arrives, reading the request and the reply (or the event summary). It drives the mascot and, later, the voice ("Speech output"), and could feed the drives in "Cognitive loop". A fixed stage, not an agent; skipped when the run is cancelled. Cost: one short call per run. Cheaper alternative once drives exist: compute the mood without a model call from drive levels and recent outcomes (approvals, rejections, failed checks), so drives set the mood rather than the mood setting drives; Nexus kept emotions and drives as one internal state.

### Speech output

Give the mascot a voice: a TTS engine feeds RoboBuddy' `speakVisemes` with real phonemes and durations, and a mood value drives eyes, mouth and voice together. Engine choice and trade-offs follow. Chatterbox would be an optional backend behind a small local server on a machine with enough VRAM; the dev laptop's 4 GB GPU is shared with the main model (see GPU lock), so voice must not compete for it. Not built.

Gathered 2026-11-05 **from memory, not fresh searches**: check licences, versions and memory figures before relying on them.

**Recommendation**
- **Kokoro** (82M params, Apache-2.0) as default: far better than its size suggests, runs on CPU or in the browser (`kokoro-js`, ONNX, WebGPU/WASM), many voices (best in English), ~300 MB at full precision (less quantised), real time or faster on CPU.
- **Piper** for small hardware (e.g. Raspberry Pi): fastest, 15–75 MB per voice, many languages, but flatter and more robotic; newer builds are GPL and each voice has its own licence.
- **Chatterbox** (MIT) when the voice itself must carry emotion: needs a GPU with ~8 GB.

**Others:** StyleTTS2 (MIT) and Orpheus (Apache) are more expressive but heavy/GPU-bound; F5-TTS and XTTS sound very good but have non-commercial weights, so avoid for anything shipped; Bark and Parler are older/slower, no longer the best choice.

**Emotion control:** Kokoro and Piper have none (only voice and speed). Chatterbox: "exaggeration" control and voice cloning from a reference clip. Orpheus: inline tags (`<laugh>`, `<sigh>`), infers tone from text. Dia (Apache): non-verbal tags, GPU-hungry. StyleTTS2: copies a reference clip's style (keep one clip per emotion). Parler-TTS (Apache): voice described in text ("sad, slow, quiet"); flexible, less polished.

**Chatterbox cost:** ~0.5B params, 2–3 GB weights, ~6–8 GB VRAM in the default setup; real time or faster on a recent GPU; on CPU several seconds per sentence (too slow for conversation); needs Python + PyTorch/CUDA so it can't run in the browser and would sit behind a small local server. A ~350M "Turbo" variant exists (availability/memory unchecked). **A 4 GB GPU (the dev laptop) is probably too small** for the standard model at full precision.

**Face integration:** Kokoro and Piper both expose espeak-ng phonemes and timing, so either can feed RoboBuddy' `speakVisemes` with real phonemes and durations instead of spelling rules guessing both (Kokoro predicts a duration per phoneme). A mood value could drive eyes, mouth and voice together: with Kokoro only speed and mouth change; with Chatterbox the voice changes too.

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

### Nexus: a self-directed loop with drives (2026-11-06)

Nexus is an earlier browser prototype by the same author: a cloud Claude model run in an unattended loop, one call per cycle, with homeostatic drives (curiosity, social and others) choosing what it does next, a memory file it appends to, and read access to its own source. Its README and the log of one 5-cycle session were reviewed against Codex; the code and legacy versions are still to review. Findings, verdicts and reasons per file: `docs/done/research-nexus-review.md`. The session is evidence for bounding self-direction: left to choose, the model spent every cycle studying its own harness, and used web search for the first time in cycle 5 after deriving memory designs from first principles that a search then showed were already published.

| Nexus feature | Where it went in Codex |
| --- | --- |
| Drives the model can retune within clamps, seed drives undeletable, capped self-made drives | "Cognitive loop", Limits |
| A drive carries its own prompt and output, not only a level | "Cognitive loop", Each drive owns a behaviour |
| Every self-change logged with its reason | "Cognitive loop", Change log |
| Wall clock, time awake, time since last session | "Cognitive loop", Elapsed time as input |
| Small prompt with the newest few items and counts; the rest fetched on demand | Already the core design (fresh narrow contexts, harness recall) |
| Session state autosaved and restored | Already built (run checkpoints and resume) |
| `REMEMBER:`/`RECALL:` markers in any reply | Not taken; see "Cognitive loop" |
| Source rewrites staged in a sandbox for the user to apply | Rejected; see "Verified self-authored skills" |
| Cloud transport via the Claude CLI or API | Not taken: Codex is local by aim |
| Harness-recorded actions at the top of each prompt | "Cognitive loop", Action record |
| Evidence graded as read / reported / inferred | "Scratchpad contract", Label evidence |
| Commands parsed from text the model did not write | Same risk noted for text tool calls (doc 3, Reactive assistant, Known limits) |

### Agent structures compared (2026-11-06)

Three ways to organise agents were compared against what is built:

| Structure | Idea | Where Codex stands |
| --- | --- | --- |
| Cognitive processes | Dedicated top-level agents per reasoning step (planner, memory manager, researcher, executor, pruner, collator, auditor, user interactor, emotion manager), run by a job scheduler | All but the emotion manager exist as stages or background jobs, not agents: `decide`, `recall`, gather, `act`, consolidation, `check` and `checks.ts`, clarification and the Inbox. The scheduler runs one job at a time |
| Domain agents | Nested domain specialists with their own memory, rules, instructions and validators (assistant → communications → email → triage) | Prototype: agent files with instructions, MCP servers and sub-agents, depth ≤ 3. Memory, validators and skills per agent not built |
| Freeform agents | Generic tree nodes; each parent decides which kind of work a child does | Closest: the task tree, where each node's `decide` picks its approach |

**Verdict:** keep the hybrid. The task tree stays the spine; cognitive processes are fixed stages and shared job types the harness runs, not agents a planner prompts; domains (and projects above them) scope tools, memory and signals. Why not the others alone:
- **Parallel agents can't run:** one model behind one lock on a 4 GB GPU; they would only queue.
- **A planner writing prompts for other agents** is open-ended planning, where the 4B model fails confidently; the harness writes prompts and the model fills slots.
- **Audit and pruning must always run.** As optional freeform choices the model would have to decide to check its own work, and small models don't; each extra option also makes `decide` harder.
- **Deep domain trees lose detail per hand-off:** the four-level example is past the depth limit; one or two levels.

Taken from them: per-domain memory and validators ("Self-improving domains"), an auditor that re-reads real state after an action, a content-driven mood stage ("Mascot: more moods"), and idle-time collation and pruning (built).

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
- Spark-X2.6 release: [aiweekly](https://aiweekly.co/alerts/sparkllm-ships-spark-x26-on-device-models-in-17b-and-4b); GGUF builds: [XHToken](https://huggingface.co/XHToken/Spark-X2.6-4B-GGUF), [AtomicChat](https://huggingface.co/AtomicChat/Spark-X2.6-4B-GGUF); vendor benchmarks: [model card summary](https://mer.vin/linkedin/spark-x2-6-4b-4b-on-device-agent-model-benchmarks-and-local-setup-linkedin/), [labmemo](https://labmemo.com/spark-x26-4b-ondevice-llm-2026-10/)
- KV cache quantization: [InventiveHQ benchmark](https://inventivehq.com/blog/kv-cache-quantization-quality-benchmark), [32K context in 8 GB](https://dev.to/plasmon_imp/q4-kv-cache-fit-32k-context-into-8gb-vram-only-math-broke-209k), [12 GB write-up](https://dev.to/kenimo49/kv-cache-quantization-i-stretched-qwen-35bs-context-8x-on-12gb-vram-2o8j), [Ollama K/V quantisation](https://smcleod.net/2024/12/bringing-k/v-context-quantisation-to-ollama/), [mixed K/V types (Reddit)](https://reddit.sentinel-team.org/posts/1thu6os/snapshots/2026-05-19T23%3A39%3A57.330026Z), [node-llama-cpp v3.18.1](https://github.com/withcatai/node-llama-cpp/releases/tag/v3.18.1)
- TurboQuant forks: [turboquant_plus](https://github.com/thetom/turboquant_plus), [turboquant-ggml](https://github.com/Keyvanhardani/turboquant-ggml), [llama-turboquant](https://www.gitlink.org.cn/okapi/llama-turboquant)
- Low-bit weight quants: [ITQ3_S](https://arxiv.org/pdf/2603.27914), [QTIP review](https://liner.com/review/qtip-quantization-with-trellises-and-incoherence-processing), [EXL3 vs GGUF](https://atomic.chat/blog/guides/exl3-vs-gguf), [IQ2 builders compared](https://www.orcarouter.ai/blog/ternary-bonsai-2-27b-vs-qwen-3-8-27b-gguf)
- MoE offload: [4 GB VRAM guide](https://insiderllm.com/guides/what-can-you-run-4gb-vram/), [n-cpu-moe vs expert cache](https://www.developersdigest.tech/blog/llama-cpp-moe-offload-n-cpu-moe-vs-moe-cache-2026), [MoE offloading explained](https://dev.to/someoddcodeguy/understanding-moe-offloading-5co6), [35B-A3B on 4 GB (Reddit)](https://reddit.sentinel-team.org/posts/1utgm9q/snapshots/2026-07-17T18%3A53%3A30.39359Z), [RTX 3060 with n-cpu-moe](https://knightli.com/en/2026/05/26/rtx-3060-llama-cpp-n-cpu-moe-local-35b/), [moe-l2](https://pypi.org/project/moe-l2/0.5.1/)
- Generative Agents (memory stream; retrieval by recency of last access, importance scored at write time, and relevance): [arXiv 2304.03442](https://arxiv.org/abs/2304.03442)
- MemGPT (main context, searchable recall store of past messages, archival store, paged by function calls): [arXiv 2310.08560](https://arxiv.org/abs/2310.08560)
- Context-Folding: [arXiv 2510.11967](https://awesomepapers.io/papers/2510.11967)
- brainos-orchestrate: [decompose.rs](https://docs.rs/crate/brainos-orchestrate/0.5.0/source/src/decompose.rs)
- Terminus-4B: [summary](https://awesomepapers.io/papers/garg2026terminus)
- 3B agent on a Raspberry Pi: [dev.to](https://dev.to/trismegistus/what-3-months-of-running-an-ai-agent-on-a-raspberry-pi-taught-me-about-task-design-1m2l)
- RoboBuddy: [github.com/x-tech-laboratories/RoboBuddy](https://github.com/x-tech-laboratories/RoboBuddy)

