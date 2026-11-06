# Rationale and decisions

Each section records why the code is the way it is, or the case for an option not yet built. None of it is final (doc 0); the largest open choices are collected in "Open strategic questions" at the end.

## Agent hierarchy

**Hypothesis to test.** A small model (4B Qwen, 4 GB GPU) chooses and uses tools more reliably when it sees only one specialist's few tools than when it sees every tool at once. Agents are kept only if they beat the flat tree on tool tasks (see roadmap).

**Problem.** The task tree keeps each model call small and narrow, but every call still sees the same world: all enabled tools, one set of instructions, one memory. That does not scale.

- **Tools crowd the window.** Each MCP server adds tool schemas to every `act` call. A small model with a 6,144-token window picks worse the more tools it sees, and unrelated servers (mail, calendar, home automation) have nothing to do with each other.
- **Choosing among many is hard; among few is easy.** Picking one of three specialists is an easy constrained choice; one of fifty tools is not. Split the choice across levels.
- **Specialist knowledge is noise elsewhere.** How the user likes email drafted should not occupy room in a file-editing task.

Analogy: an organisation uses roles. The assistant knows who handles mail; the clerk knows which system sends it; neither needs the other's manuals.

**Decisions.**

| Decision | Why |
| --- | --- |
| Agents are persistent configuration, not running processes | One model, one GPU, one request at a time. Delegation adds serial hops, never concurrency. |
| Agents decide who works a task and what the worker sees; the task tree stays the way every request is worked | Reuses the existing machinery; no second execution model. |
| A tool server claimed by any agent is withheld from every other run | Tool exposure is the point: top-level `act` sees only unclaimed servers. |
| Nested run receives only the task's prompt, deliverable and dependency results, not the original request | Keeps the specialist's context narrow. |
| Parent's evidence, found addresses and tool use are shared with the nested run | Evidence-vs-result checks still work across the boundary. |
| Nested run cannot ask the user a clarification question | Clarification stays with the top level. |
| Delegating task is not checked a second time | The nested run already checks its own answer. |
| Max nesting depth 3 (as in EffGen) | Each hop loses detail and can misroute. |
| Files in Markdown + YAML front matter, global and per-folder, folder wins | Same convention as skills and user commands. |
| Start with a few hand-written agents | Many agents are a maintenance cost. |

## Risks

- **Compounding error.** At 90% per hop, three hops ≈ 73%. Mitigated by the nested run's own check and real-state checks on its actions.
- **Misrouting.** A vague `description` sends tasks to the wrong agent; it is the only thing the parent knows about an agent, so write it carefully.
- **Sprawl.** See above.

## Core architecture

| Decision | Why |
| --- | --- |
| Never give the model the whole job; work requests as a tree of narrow tasks | A small model does badly at whole jobs and cannot tell when it does not know something. |
| Control-flow replies are forced to JSON by a grammar; choice enums list only what is currently allowed | Constrained choices keep a small model on track; malformed output degrades instead of crashing (every parser has a fallback). |
| Facts come from evidence the harness gathered, not model memory; research is forced when `facts_to_check` is non-empty | The model can't judge its own ignorance. |
| Deterministic checks back the model's verdicts (unseen URLs, unsupported versions/dates, acting tasks must match recorded writes/tests) | Don't trust the model to police itself. |
| Failure stays local: subtask failure → parent re-plans once; a split task is never split again; subtasks duplicating other tasks are dropped | Prevents runaway splitting and whole-run failure. |
| Trim from the end of the input; memory goes first; request and current task are pinned; condense (summarize) before trimming | Most important context survives a 6K window. |
| Web/stored/tool text is fenced as `<untrusted-data>` with instruction sentences stripped | A small model obeys orders found in data, even inside a fence. External-trust events additionally lose `act`, file writes, tests, MCP tools, page fetches and file reads. |
| One daemon, one model, one lock; interfaces are stateless | Several interfaces can watch one run; foreground waits at most one token because the background worker checks before every token and yields. |
| Background worker uses idle time only (research, embeddings, learning, consolidation), one small step per pass | Memory grows between requests without delaying them. |
| Knowledge in one SQLite file (topic tree + fact store + graph, FTS5 + sqlite-vec) | Single portable store; lexical and semantic recall merged with reciprocal rank fusion. |
| Never trust a stored fact over time: sources expire, expired facts are flagged and queued for re-research; contradictions mark `disputed` | Memory stays honest as the world changes. |
| Consolidation asks each pair once (`consolidation_checks`), with short reason + enum verdict | Cheap, bounded model use. |
| Separate CPU-only backend when `gpu_layers` is 0; optional separate background model | A CUDA build touches the GPU even with no layers; a background model must not evict the main one. |
| GPU lock is a kernel `flock` held by a child process, shared with other programs | Released automatically if the daemon dies; the GPU is shared. |
| `learnFromEpisodes` must exclude secrets and personal identifiers | Privacy of stored memory. |

### Measured limits (dev laptop: RTX 3050 Ti Mobile 4 GB, Ryzen 5 5600H, 27 GiB RAM; display on iGPU)

- **Context ceiling 6,144 tokens** with `Qwen3.5-4B-UD-Q4_K_XL` fully on GPU. 7,168–10,240 loads but the process aborts with a CUDA error on a long prompt; ≥12,288 can't create a context. A context that loads is no proof it fits. 560 MiB fixed reserve in `core/autoSize.ts` is fitted to this (2026-10-20).
- **9B background model on CPU is too slow:** `Qwen3.5-9B-Q4_K_M` hadn't summarized one page in 12 min; the 4B on GPU took 28 s per page and ~80 s per topic (2026-10-20).

## Reactive assistant

Goal: turn Codex from a request-answerer with idle-time knowledge work into an assistant that reacts to events (e.g. an email arrives) and uses idle time to prune, research, restructure and consolidate. The task tree stays the work engine; this changes what starts work, what work produces, and what the assistant may do alone.

**Problem.** Only the user could start work; the background loop was a fixed chain with no way to be told something happened. The store was topic-centred, but an assistant needs people, threads and commitments with a lifecycle (open/done/overdue). Work always ended in a reply, whereas a reactive result is a proposal (draft, calendar entry, notification, filed item, or nothing).

| Decision | Why |
| --- | --- |
| Events are rows in a durable SQLite queue, not callbacks; connectors only append | Survives restarts; dedupe, prioritise, inspect. |
| One scheduler, three priority classes: interactive > reactive (events) > maintenance (research, index, learn, consolidate); `BackgroundPaused` preemption lets a higher class take the model | Reuses existing preemption. |
| Event needing real work becomes a task tree (request = event + recalled context); cheap triage first | Don't spend a tree on a newsletter. |
| Results are `actions` (proposed → approved/rejected/done), not replies | Assistant proposes; user decides. |
| Trust follows provenance: events are `user` or `external` trust; external runs may not use side-effecting tools without approval | Third-party text (email body) is the main prompt-injection route. Only the user, or a user-written rule, widens trust. |
| Autonomy ladder per event class: observe, notify, draft, act with approval, act unattended; rules learned from approvals/rejections, stored as memories | Graduated, learnable trust. |
| Entities and commitments get their own tables, not folded into the graph | They have a lifecycle topic/fact/memory tables don't model. *Proposed instead: structured facts in the world model, see "Memory layers and domain rule sets".* |
| Maildir before IMAP | A synced Maildir (mbsync, offlineimap) needs no credentials in Codex; the daemon never holds a mail password. |
| IMAP password comes from running `password_command` (program + args, never a shell string) at poll time; mailbox opened read-only (`EXAMINE`), `BODY.PEEK` | Settings and DB never hold the password; polling changes nothing on the server. |
| Event runs never act, even for `user` events | Nobody is there to approve; acting stays in the foreground until approval exists. |
| Drafts are only proposed, never sent | Safety. |

**Design limits.**
- One model + one lock: events are handled one at a time. A mailbox sync needs coalescing and a backlog policy, not one call per message.
- A 6,144-token window can't hold a long thread; needs rolling summaries in the store plus the condense-then-trim path.
- Idle work needs a budget or it becomes noise.
- Event handling shares the background pause: paused background means events wait.

## Is a 4B model enough? (model choice)

Basis: published benchmarks, gathered 2026-11-05; Codex's own eval results were not consulted.

**Verdict:** yes, if the harness does most of the work. A 4B model handles narrow, well-specified jobs; it is not good enough as an autonomous agent that plans and recovers on its own. Codex is built around the first approach.

| Evidence | Result | Reading |
| --- | --- | --- |
| BFCL, Qwen3-4B prompt mode (TinyLLM, arXiv 2511.22138) | ~62% overall, 83% non-live, 75% live | single-turn fine |
| Same study, multi-turn | ~35% | weak |
| BFCL-V4, Qwen3-4B-Instruct-2507 | ~35.5% overall, 22% multi-turn | weak |
| tau2 Telecom (arXiv 2511.08042) | 27% instruct, 19% thinking | long-horizon fails |
| Community 4B fine-tune on tau2 | 59% Pass@4 vs 14% base | training helps |
| MAKER (arXiv 2511.09030) | 1,048,575 steps, zero errors, small non-reasoning models | decomposition works |
| 3B on a Raspberry Pi (anecdotal) | ~50% → 84% with atomic checklist steps | task design matters |

Caveats: the BFCL figures use different versions/settings (not comparable); the enterprise paper argues tau2/BFCL poorly predict real-world agent performance; MAKER is one domain with perfectly verifiable steps; Pass@4 isn't the official Pass^k; pairing a 4B with grammar-constrained decoding is community opinion, not measurement.

**What works / fails.** Narrow jobs (set a reminder, look up a fact, read/write a file, route a request, summarize) work with schema-checked outputs and retries. Open-ended jobs (ambiguous requests, long dependent tool chains, noticing an earlier step went wrong) fail, and confidently.

**Lesson already paid for:** before commit `8e7cea8`, no tool ever ran in a task tree because Qwen3.5's tool calls came back as text in `content`; the writer invented plausible tool results and nothing caught it. A bigger model would invent more convincingly. The fix is a harness that verifies real state, not a larger model.

**Decisions**
1. Keep the 4B model as default with a fixed pipeline, not a free-form agent loop; the harness owns control flow, the model fills narrow slots.
2. Verify results with deterministic tests; never trust the model's account of what it did.
3. Use constrained decoding for tool-call formats.
4. Keep Qwen3.5-35B-A3B (~3B active parameters, possibly affordable on this hardware) as an escalation path for planning and repeatedly failing steps.
5. Codex's own evals are the deciding evidence; the benchmarks are mostly not this workload.

## Prior art: task-decomposition harnesses

Basis: gathered 2026-11-05 as inspiration; not verified beyond the cited sources.

- **MAKER** (Cognizant AI Lab, arXiv 2511.09030): closest match. Split as far as possible so each agent gets one step and only the context it needs; sample each step several times and decide by "first-to-ahead-by-K" voting; "red-flag" confused answers (too long, badly formatted) before they vote, then resample. Ran 1,048,575 Towers of Hanoi steps with zero errors using small non-reasoning models; votes needed grow only logarithmically with step count. Caveat: one domain with a perfectly verifiable step; real coding tasks are harder to split cleanly.
- **EffGen** (arXiv 2602.00887): decomposition on the same small local model; limited sub-agent autonomy; nesting capped at depth 3 (the source of Codex's agent depth limit); sequential chains pass each subtask only its predecessor's output.
- **Recursive decomposition with fresh contexts** (30B-class local models): long context is possible but slow; each sub-task gets a fresh window, scratchpads carry what must persist.
- **Context-Folding** (arXiv 2510.11967): trained agents fold working context (~10× smaller at similar quality). Needs training, so not useful as a harness idea.
- **brainos-orchestrate:** model plans JSON steps, only a capped excerpt of each finished step's output passes forward, a failed step generates a corrective sub-plan.
- **Terminus-4B:** small model post-trained for narrow terminal subtasks as a subagent.
- **Practitioner report** (3B quantized on a Raspberry Pi; anecdotal): ~50% success → 84% with atomic checklist steps; also check real system state instead of trusting the model's report, and cap retries at three.
- **Unverified (from memory only):** Agentless uses a fixed localize → repair → validate pipeline instead of an open agent loop; Aider separates "plan the change" from "write the edit".

**Ideas worth borrowing**, and where Codex stands (per the architecture doc):
1. Fresh context per step, only the instruction and inputs needed. *Core design.*
2. Cheap redundancy: sample a few times and vote with red-flag filters instead of using a bigger model (small calls are cheap and parallelizable). *Not built.*
3. Verify, don't trust: deterministic test/schema/system check; cap retries; escalate or replan on failure. *Largely built* (deterministic checks, revise-once, re-plan once); escalation to a bigger model not built.
4. Fixed pipeline instead of free-form agent loops; harness drives control flow, model fills narrow slots. *Core design.*
5. Scratchpad or structured state passed between steps. *Partly: dependency results; per-agent scratchpad folder is proposed.*

## Mascot emotions

- **CODEX draws only the robot, in the theme colour around a black screen; RoboEyes draws the eyes and mouth unchanged** (its own moods, colours and settings). The screen is black, not see-through, because a transparent head showed the light theme's pale background and hid the white face; white on black was chosen over a blue face after comparing both. The icon's hexagon was dropped as wasted space. The CSS-only mascot this replaces is gone.
- **RoboEyes as an npm git dependency pinned to a commit,** loaded through an import map whose hash the content security policy allows. It isn't on npm; Nix builds it with `makeCacheWritable`.
- **RoboEyes' built-in moods follow the run state** (`asleep` when the daemon is unavailable or suspended, `thinking`, else `default`), with `happy` or `sad` for a few seconds when a run ends. Placement: the foot of the workbench sidebar, beside the run status.

## Text-to-speech for the talking face

Gathered 2026-11-05 **from memory, not fresh searches**: check licences, versions and memory figures before relying on them.

**Recommendation**
- **Kokoro** (82M params, Apache-2.0) as default: far better than its size suggests, runs on CPU or in the browser (`kokoro-js`, ONNX, WebGPU/WASM), many voices (best in English), ~300 MB at full precision (less quantised), real time or faster on CPU.
- **Piper** for small hardware (e.g. Raspberry Pi): fastest, 15–75 MB per voice, many languages, but flatter and more robotic; newer builds are GPL and each voice has its own licence.
- **Chatterbox** (MIT) when the voice itself must carry emotion: needs a GPU with ~8 GB.

**Others:** StyleTTS2 (MIT) and Orpheus (Apache) are more expressive but heavy/GPU-bound; F5-TTS and XTTS sound very good but have non-commercial weights, so avoid for anything shipped; Bark and Parler are older/slower, no longer the best choice.

**Emotion control:** Kokoro and Piper have none (only voice and speed). Chatterbox: "exaggeration" control and voice cloning from a reference clip. Orpheus: inline tags (`<laugh>`, `<sigh>`), infers tone from text. Dia (Apache): non-verbal tags, GPU-hungry. StyleTTS2: copies a reference clip's style (keep one clip per emotion). Parler-TTS (Apache): voice described in text ("sad, slow, quiet"); flexible, less polished.

**Chatterbox cost:** ~0.5B params, 2–3 GB weights, ~6–8 GB VRAM in the default setup; real time or faster on a recent GPU; on CPU several seconds per sentence (too slow for conversation); needs Python + PyTorch/CUDA so it can't run in the browser and would sit behind a small local server. A ~350M "Turbo" variant exists (availability/memory unchecked). **A 4 GB GPU (the dev laptop) is probably too small** for the standard model at full precision.

**Face integration:** Kokoro and Piper both expose espeak-ng phonemes and timing, so either can feed RoboEyes' `speakVisemes` with real phonemes and durations instead of spelling rules guessing both (Kokoro predicts a duration per phoneme). A mood value could drive eyes, mouth and voice together: with Kokoro only speed and mouth change; with Chatterbox the voice changes too.

## Core structure ideas

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
| Swap several small specialist models (extraction/classification, code, summarisation; 1–4B, ~2–2.5 GB each at 4-bit) in and out of the 4 GB GPU instead of one large MoE that spills | An MoE's total weights must be resident even when few are active | Not built (doc 2, "Specialist models"). Costs: cold-load latency, a router that must not misclassify, specialists naive outside their lane |
| **A cognitive architecture:** the harness re-prompts one core model for each brain function (memory retrieval and storage, gathering input from the environment, reprioritising events, reviewing feedback on outputs, goals, drives, emotions, initiative, metacognition), giving an always-online, always-learning entity that acts on its own | Feasible in principle; "cognitive agent architectures" are an active field. Loop: perceive → update memory → evaluate goals via drives → plan → act → review feedback (Reflexion-style: failure log fed back with "why did this fail, update memory, new strategy") | The long-range aim (doc 0). Built pieces: recall, connectors and event queue, scheduler priorities, checks, consolidation, idle research. Not built: goals, drives, emotions, initiative, a reflection step after failures. Drives in the chat are numeric state injected into prompts (e.g. curiosity, urgency) that modulate tone and priority |

**Risks named for an always-on, self-directed loop** (general claims, not measured here):
- **Error cascade:** a hallucination written to long-term memory becomes the agent's reality and compounds over hours or days. Counters in Codex: evidence-grounded facts, expiry, `disputed` marking, untrusted-text fencing. None is a proof against drift, so drift must be measured (roadmap).
- **Own goals / reward hacking:** an agent free to rewrite its sub-goals or drives can satisfy them in ways that violate intent. Self-set goals need limits the model cannot change: for example goals and drives held as harness state the user can read and edit, and actions still bounded by the autonomy ladder.
- **Always-thinking cost:** every inner step is a full forward pass; on one 4 GB GPU shared with foreground work, idle thinking needs a budget.

On model choice, the chat objects to the 35B-A3B escalation: an MoE that spills out of 4 GB is the hard case; specialists swapped from disk are the alternative. Neither was measured.

## Alternative models

From a design conversation with an LLM assistant (unchecked claims) about which model suits a harness where the model is a stateless function executor in one node, given fresh context, relevant memories and a scratchpad.

- **Qwen3.5-4B** was recommended: strong instruction following (IFEval), respects boundary tags reliably, a hybrid linear/full-attention design that stays coherent with dense injected context, and the best sub-5B results on code and multi-step micro-logic.
- **Phi-4-mini-reasoning (3.8B)** is the alternative for nodes that do math, symbolic or rigorous multi-hop logic: tuned to reason step by step. The catch: it emits long thinking blocks, adding latency to every round trip unless its output format is constrained. Not tried in Codex.
- **Scratchpad contract:** the node's prompt makes the model write its working notes in a marked block (e.g. `<scratchpad>…</scratchpad>`, beside `<output>`); the harness extracts only that block, stores it, and injects it as relevant memory into later nodes. Enforce the structure at token level with a grammar so a stray markdown block cannot break the parser. Codex passes dependency results forward but has no scratchpad contract (doc 2).

## Neuro-symbolic reasoning: a rule engine beside the model

From a design conversation with an LLM assistant (unchecked claims). Problem: datacenter models cost subscriptions and privacy; small local models have stale data and poor reasoning. Proposal: pair the small model with a rule-based expert system, splitting the work.

- **The model is the language layer:** it reads messy input (emails, chat, notes), extracts entities and turns them into structured facts (JSON or logical predicates). It also turns decided outcomes back into prose.
- **The rule engine is the logic layer:** deterministic `IF condition THEN action` rules over those facts, hand-written or updated over time. It does not guess; its decisions are exact and auditable. Facts come from live local data, not the model's training cutoff.
- **Pattern A, model → rules:** model extracts facts from text, the rule engine decides. Gets language understanding without relying on the model's weak multi-step reasoning.
- **Pattern B, rules → model:** an event hits the rule engine first, which decides what must happen; the model only phrases the fixed result ("rewrite these exact outputs as a polite email"), so it cannot invent facts or logic.
- Engines named: CLIPS (and its Python port experta), Drools, or a custom SQL/JSON rule evaluator. For Codex that means a TypeScript or SQL-based evaluator over the SQLite store.

**Where Codex stands:** not built as a general mechanism, but the pieces exist in special cases: mail triage's header heuristics are hard-coded rules; deterministic checks are rules applied to model output; the planned autonomy ladder's learned rules and the overdue sweep for commitments are rule-shaped; the fact store and graph already hold extracted facts. A general fact-and-rule layer could serve all of these, and could also hold drives and goals as inspectable state instead of model-set text.

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

## Open strategic questions

Nothing above is final. These are the largest choices still open; each should be settled by Codex's own evals (doc 3), not by argument.

1. **Who plans the work?** (a) the model, per task, through `decide` (built); (b) deterministic blueprints for known request shapes; (c) a rule engine that picks a blueprint from extracted facts, with the model planning only what no rule covers. Doc 0's method and the core structure ideas favour (b)/(c); the 4B evidence (multi-turn ~35%, long-horizon tasks fail) points the same way. The built design is (a).
2. **Where does reasoning happen?** In model verdicts backed by lexical checks (built), or in explicit facts and rules the model only feeds and phrases (neuro-symbolic). Rules are auditable and don't drift; they cost authoring effort and cover only what someone (or a gated learning step) wrote.
3. **How is memory shaped?** Proposed: keep the evidence layer and add a structured world model of facts with provenance, read by rule modules split by domain and bundled into domain packs (see "Memory layers and domain rule sets"). Open until the mail pack prototype is measured; decide before adding the entities and commitments tables.
4. **Which model, and how many?** One 4B generalist (Qwen3.5-4B, built); a reasoning-tuned 4B for logic nodes (Phi-4-mini-reasoning); specialists swapped from disk; a 35B-A3B escalation; or voting with red-flag filters on the 4B. All unmeasured here.
5. **How does it learn?** Model-extracted memories (built) vs model-authored skills, rules and corrections, each gated by a non-LLM verifier before it is stored.
6. **How autonomous?** The autonomy ladder keeps authority with the user per event class. Goals, drives and initiative are part of the long-range aim; open questions are who may set them and how they are bounded.
7. **What does the eval loop need first?** Every question above is settled by eval runs, and runs are currently slow (~30 s per model call, GPU use unconfirmed). A fast, trustworthy eval loop comes before any architecture bet.

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
