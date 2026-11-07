# Architecture

What is built, how it works, and why it is built that way. Only what exists in `src/` belongs here; proposals and open questions are in doc 2, and an approach moves here, with its rationale, once it is built. Paths are under `src/`. Built statuses were checked against the code on 2026-11-06 (table names, approaches, daemon methods, window pages, eval assets); behaviour details were not re-tested. Nothing here is fixed: doc 2, "Open strategic questions", lists where the design may change.

## Core architecture

Never give the small model the whole job. Work each request as a tree of narrow tasks; each call sees only what it needs; control-flow replies are grammar-forced JSON; facts come from harness-gathered evidence, not model memory. A SQLite knowledge store keeps evidence between requests, and a background worker turns it into facts, summaries and a topic hierarchy in idle time.

### Processes

```
Electron window (main+renderer) / one-shot CLI
        └── Unix socket $XDG_RUNTIME_DIR/codex/daemon.sock (newline-delimited JSON) ──┐
codex-daemon: one Node process, one event loop                                       ◄┘
  socket server | active run (one at a time) | background loop (only when no run)
        └── model lock + ModelCache → node-llama-cpp (one GGUF) → KnowledgeStore (node:sqlite, WAL)
```

- **Daemon** (`daemon/daemon.ts`) owns model, settings, active run, background worker. Interfaces are stateless renderers of broadcast events (`run.token`, `run.tree`, ...), so several can watch one run. Protocol (`shared/protocol.ts`): requests `{id, method, params}`, replies `{id, result|error}`, events `{event, data}`.
- **Interfaces:** Electron window (`main/`, `renderer/`; main starts a daemon if none answers) and CLI (`cli/index.ts`; with no daemon it runs in-process and never starts the background worker). Both use `daemon/client.ts`.
- **One model, one async-mutex lock.** A run holds it throughout. The background worker takes it per model call and checks before every step and streamed token whether a run started; if so it throws `BackgroundPaused`, requeues its job and releases the lock. Foreground waits at most one token.
- **ModelCache** (`core/model.ts`) reloads only when model path, context size or GPU layers change. Optional `background_model_path` gets its own cache and lock (never evicts the main model, yields to runs, unloaded after 5 min idle).
- **GPU lock** (`core/gpuLock.ts`): exclusive `flock` on `$XDG_RUNTIME_DIR/codex-gpu.lock`, shared with other programs, held by a child `flock` process so the kernel frees it if the daemon dies. `CODEX_GPU_LOCK` overrides the path or disables (empty). Inherited descriptor is reused under `flock`. The lock is held for as long as a GPU model stays loaded, so a job queued on it can be waiting on an idle daemon, not a busy one; `codex suspend` frees it.
- **Suspend/resume** (`codex suspend|resume`): cancel run, unload both models (frees GPU lock), pause background, refuse runs, broadcast `suspended.changed`. Triggers are left to the user's launcher.
- **Tray** (`main/tray.ts`, `main/inbox.ts`, in Electron main not the daemon): menu from daemon status/events; `Inbox (n)` from `actions.changed`; desktop notification for new actions unless the window is in front. Window hides to tray only if a StatusNotifierWatcher exists (checked via `busctl`); a hidden window stays connected so the daemon's unused-exit timer never starts.

### Request flow: task tree

`core/taskTree.ts`; uses `model.ts`, `evidence.ts` (search, recall, page summaries), `checks.ts` (non-model checks). Request = task `1` (deliverable: a complete reply); subtasks numbered by path (`1.2.3`). `TaskTree` caps depth (`max_task_depth`) and size (`max_task_nodes`); `TaskTreeRun` works depth-first.

```
work(task)
 ├─ decide: JSON {reason, facts_to_check, approach, search_queries, subtasks}  (schema lists only allowed approaches)
 ├─ decompose: work each subtask in order (a failure → re-plan the rest once) → combine → check → revise once → check
 └─ answer | research | files | act: gather (stored knowledge / web, then tool loop) → write → check → revise once → check
      └─ still failing → split into smaller subtasks (a split-created task is never split again)
```

Rules that keep a small model on track:
- **Constrained choices:** `approach` enum holds only what settings allow (`act` only if writes/tests/MCP enabled and mode permits; `decompose` only with room for two more subtasks). Enforced as a llama.cpp grammar.
- **Research is forced:** non-empty `facts_to_check` turns `answer` into `research`. Top task always searches the request's words; a top-level `answer` still gets one quick search unless arithmetic or rewriting pasted text.
- **No runaway splitting:** subtask whose content words match its parent or another task is dropped; <2 real subtasks means do it directly; dependencies only point backwards.
- **Failure stays local:** subtask error → `failed`, parent re-plans once; only a top-task error fails the run.
- **A decision can't sink the run:** `reason` is one short sentence (≤ `REASON_MAX_CHARS` = 300, enforced by the grammar) so the model can't think aloud in it until the reply runs out; a `decide` call that errors (token limit, repetition, bad reply) falls back to `defaultDecision`: `research` if the prompt needs the web, else `answer`.
- **Steps are records:** each step of a task (Deciding, Researching / Reading files / Acting, Writing, Checking, Revising, Planning subtasks, Combining) runs through `TaskTreeRun.step` and is kept on the task as `{name, status, started_at, ended_at, error}`. Steps go out with every tree snapshot and are saved in the checkpoint; a step cut off by a restart shows as failed with "Interrupted". The run holds the model lock across all of them.
- **Input section order** (most important first; trimming cuts from the end so memory goes first): original request, current task + deliverable, date, correction, call's own material, clarification, dependency results, gathered evidence, tree outline, recalled memory.

### Shared machinery

- **Model calls** (`runStage`): one system prompt + one user message, streamed; optional JSON schema → grammar. Qwen thinking off via chat wrapper. A reply that starts going in circles is stopped early (`isRepeating` in `core/model.ts`: the last 1,200 characters, checked every 200, deflate to under 0.2 of their size) and reported as `finish_reason: 'repetition'`, which `runStage` and the tool loop raise as an error like the token limit. Decisions, checks and background extraction always use a schema; every parser has a malformed-reply fallback (degrade, don't crash).
- **Context budget** (`core/contextBudget.ts`): token counts from the model's tokenizer. Budget = context − reply budget (1024 decisions, 512 checks) − system prompt − template reserve. On overflow: largest unpinned sections are summarized first (each once per run, cached), then trimmed. Request and current task are pinned.
- **Tools** (`core/tools.ts`): `web_search` (DuckDuckGo HTML via fetch), `web_fetch` (public addresses only, rechecked after redirects), `list_directory`, `read_file`, `write_file` (needs `allow_file_writes`), `run_tests` (needs `enable_test_execution`). Paths confined to `filesystem_root`; sensitive names refused. `core/mcpTools.ts` adds MCP-server tools (`@modelcontextprotocol/sdk`) limited to each server's `allowed_tools`. `core/toolStage.ts` runs the gather tool loop: per-approach allow/block list, max `max_tool_calls`; fetched pages summarized in chunks for a model-supplied focus, then merged. Qwen writes tool calls as `<tool_call>` text the chat template does not turn into real calls; `textToolCalls` parses its XML and JSON forms. Findings that contain raw `<tool_call>` markup mean calls are not being parsed, so trace the tool calls before trusting such a run.
- **Untrusted text:** sections in `UNTRUSTED_HEADINGS` (search results, stored facts, recalled memory, tool findings, sources, background subtopic summaries), page material sent to the summarizer, and every tool result are wrapped in `<untrusted-data>` tags after stripping any such tag and replacing instruction-giving sentences with `[instruction removed]` (`removeInstructions`). Fencing happens at render time, after trim/condense, so a cut can't drop the closing tag.
- **Deterministic checks** (backing the model's verdict): cited URL absent from captured evidence; after research, a version/date absent from evidence and request (dates compared by value, code-block numbers ignored); an acting task must report what its recorded file writes/test runs really did; when all searches found nothing, the writer is told not to describe what it couldn't look up.

### Knowledge store

`core/knowledge.ts`: one SQLite file (`knowledge_db_path`), WAL, opened per operation via `node:sqlite`, vectors via `sqlite-vec`. Schema versioned by `PRAGMA user_version`; migrations commit with the version bump; a newer database is refused.

| Table | Holds |
| --- | --- |
| `topics` | unique case-insensitive name, `parent_id`, priority, summary, use count, last researched/placed |
| `sources` | URL (unique), title, snippet, page summary, query, topic, retrieved + expiry |
| `facts` | statement under a topic, source, confidence 0–1, status (`active`/`disputed`/`pruned`), use count |
| `user_memory` (the memories) | stores: general, user, locations, software, project, research, code; learned/probed/user-stated; `active`/`superseded` |
| `task_runs` | Checkpoint of an unfinished task tree (prompt, options, state, status, tasks done/total) so it resumes after a restart |
| `episodes` | each finished request: prompt, mode, checklist/tree outline, answer, outcome, tree snapshot |
| `knowledge_search` / `memory_search` | FTS5 over sources / over facts + episodes |
| `embeddings` | vector per fact and topic, with model and source text |
| `graph_nodes`, `graph_edges` | topic/source/entity nodes; `contains`, `supported_by`, extracted relations (edge optionally tied to a source) |
| `research_queue` | per-topic jobs pending/running/done/failed, ≤1 pending per topic |
| `consolidation_checks` | stored verdict per compared topic/fact/memory pair |
| `events`, `actions` | connector/timer events (source, type, dedupe key, trust, priority, payload, status, outcome); what handling proposed to the user (`proposed`/`approved`/`rejected`/`done`) |

Three mirrored layers: topic tree (`parent_id`), fact store (`facts`+`sources`, FTS5), relationship graph.

**Reads during a request**
1. **Recall** (`KnowledgeStore.recall`) before the first model call: memories from each non-skill store (up to `MAX_RECALLED_MEMORIES` per store) plus facts and episodes sharing half the prompt's search terms (three for a longer prompt; stopwords removed, ≤12 terms; most shared first). If <5 match, walk the topic tree from the most specific topic whose full name appears in the query. With an embedding model (`core/embeddings.ts`): query vector vs all fact vectors via sqlite-vec above a similarity floor, merged with word matches by reciprocal rank fusion; if no topic is named, the closest-meaning topic supplies the branch. Each fact carries its ancestor topic chain + summaries; up to 5 graph relationships of named entities are added. Output is a "Remembered context" section; recall bumps use counts. Each subtask recalls for its own prompt; each search query recalls a "Stored facts" evidence section; if facts or summaries answer every query, the tool loop is skipped. A fact whose source expired (or with no source, older than the source lifetime) is flagged possibly out of date, can't answer alone, and queues its topic for research.
2. **Search with memory** (`searchWithMemory`) per query: look in `knowledge_search` for unexpired sources sharing half the query terms. Hit → "Local knowledge result", no web search (and tool loop skipped if all queries hit). Miss → `web_search`; a search finding nothing queues the query as a research topic.

**Writes during a request:** web results stored as sources under a topic named for the query (queued for research unless it already has facts); each `web_fetch` page summary saved on its source; sentences a check rejected for unsupported version/date queued as research topics (led by the first 80 chars of the request, ≤3 per check); the finished request saved as an episode (with tree snapshot).

### Background worker

`HarnessDaemon.backgroundLoop` runs for the daemon's life:

```
paused and no manual request → wait poll interval;  run active → wait 1 s
else: requeue topics researched longer ago than background_refresh_interval_hours
        (half that for topics recalled 5× and used since; most used first)
      then the first available of (reactive class before maintenance class, order in core/scheduler.ts):
        pollConnectors | handleNextEvent | researchOneTopic | indexKnowledge (CPU embedding model)
        | learnFromEpisodes | consolidateKnowledge
      worked → wait 0.2 s, else poll interval
```

- **Events:** `MailConnector` (`core/mail.ts`, Maildir folders in `mail_maildir_paths`) and `ImapConnector` (`core/imap.ts`, `mail_imap_accounts`) queue events. `handleNextEvent` (`core/events.ts`) claims the most important event and runs its type's handler: `notify` → proposed action; `email.received` → triage (`core/triage.ts`); no handler → `ignored`. `email.draft` and `user.request` are worked as task trees (`core/eventTree.ts`): holds the model lock, stops when foreground work arrives (event requeued), result becomes a `draft`/`result` action. A tree from an `external`-trust event runs with `trust: 'external'`: no `act`, file writes, test runs or MCP tools; research may search but not fetch pages or read files. Interfaces use `post_event`, `events`, `actions`, `resolve_action`. Detail: "Reactive assistant" section below.
- **`researchOneTopic`** (`core/background.ts`): claim highest-priority job; `web_search` the topic, fetch + summarize the first two distinct pages (skip near-duplicate text); number all page summaries and snippets as sources; extract ≤5 facts per page and from snippets together, each with source number and `low|medium|high` confidence (0.3/0.6/0.9), in small groups so one failure loses only its own; drop facts stating a version/date absent from all sources, and demote to low confidence facts whose values or half their words are missing from the cited source (or that cite none); one overview call yields topic summary + ≤5 entity relationships (drop summary sentences with unsupported versions/dates); store all. Tree placement is left to consolidation. Paused job → `pending`; other error → `failed` with message; jobs left `running` by a dead daemon → `pending` at next start.
- **`learnFromEpisodes`:** ≤5 unprocessed episodes → durable preferences, projects, corrections (secrets and personal identifiers explicitly excluded) plus ≤3 general subjects worth researching (queued if no facts yet). Episodes marked processed even on failure so one bad batch can't block.
- **Consolidation** (`core/consolidation.ts`): one small step per pass so it yields fast.
  1. No model (`KnowledgeStore.tidy`): break topic parent loops; merge topics with same words and facts differing only in case/punctuation; remove empty topics; mark never-recalled low-confidence facts `pruned` after `background_prune_after_days`; past `background_max_store_megabytes` delete least valuable first (pruned facts, finished task runs, processed episodes, expired uncited sources, least used facts) with their search entries/vectors until under 90% of cap.
  2. One model call per pass, in order: topic-name check (rename to ≤5-word title, folding into an existing same-name topic and requeueing research; or remove if no subject, no facts, only sentence-length searches found it; applies to each researched topic once and any name >5 words/40 chars); compare two topics (same / one broader / different); re-place a topic under the narrowest of ≤20 related topics, the top level, or a new broader subject (a move under an existing topic needs a second pair-comparison call to agree it is broader); compare two facts in one topic (same / contradict / different); compare two memories in one store. Candidates must share ≥half their words, or (topics, and facts under one topic) have embedding cosine ≥ 0.75. Replies are a short reason + schema-enum verdict, stored in `consolidation_checks` so each pair is asked once.
  3. Merges keep the more trusted item and carry over facts, sources, subtopics, queued research, graph edges. Contradicting facts → `disputed` + topic requeued; contradicted memory's older side → `superseded`. Disputed/pruned/superseded items are no longer recalled.

### Data flow

```
prompt → recall → "Remembered context" → decide → searchWithMemory (hit: local result | miss: web_search → sources+topic → research_queue)
  → gather (tool loop; web_fetch → page summary saved on source) → write → check (model verdict + URL/value checks) → revise/split
  → answer → episode → learnFromEpisodes (idle)
research_queue → researchOneTopic (idle) → facts, summaries, graph → consolidateKnowledge (idle): merge, re-file, dispute, prune
```

### Other built features

Listed as done in the old `TODO.md`; not yet checked against the code.

- **Resume:** an unfinished task tree resumes after the daemon restarts (checkpoints in the task-run table). The interfaces show a task's result when its row is chosen (`renderer/taskView.ts`).
- **Approval gates** for consequential actions in foreground runs.
- **Standing instructions** from `CODEX.md` or `AGENTS.md`, global and per folder, go into every model call (`core/instructions.ts`).
- **Slash commands:** `/remember`, `/memories` and `/forget` manage memories; users define their own commands as Markdown files; `/init` writes a folder's `CODEX.md` (`core/commands.ts`, `renderer/slashCommands.ts`).
- **Memory stores:** general, user, locations, software, project, research skills, code skills. The machine is probed to fill the environment stores (`core/environment.ts`); user memories are recalled by relevance and recency; project memories stay with their folder; each memory records why it holds; each task gets the skills its approach uses.
- **Desktop:** system tray, launch at login (`main/autostart.ts`), suspend and resume.
- **Window views:** knowledge store as a graph (`renderer/knowledgeGraph.ts`, force-graph) and a knowledge view (`renderer/knowledgeView.ts`), Inbox, settings form.
- **Task graph** (`renderer/taskGraph.ts`, force-graph): the Workbench's Graph toggle shows the run's tasks as boxes coloured by state, one row per tree level, each task's steps as a chain of smaller boxes beneath it, subtasks hanging from the step that planned them, and dashed "builds on" arrows only for the chosen or pointed-at task. It updates live from the tree snapshots; clicking a task or step opens that task.
- **Evals** (`core/evaluation.ts`): the bare model against the harness on a fixed task set, and with the store empty against filled. A recall benchmark scores recall against fixed questions with known relevant facts (`core/recallBenchmark.ts`).
- **Tests of note:** untrusted-text fencing against hostile pages; schema migrations from every earlier store version.

### Why it is built this way

| Decision | Why |
| --- | --- |
| TypeScript on Node 24 with node-llama-cpp and one Electron window (tray included); ported from Python, landed 2026-11-05 at `5942075` | One Electron app in place of three Python interfaces (Textual TUI, GTK app, CLI). The Python code is deleted. |
| Never give the model the whole job; work requests as a tree of narrow tasks | A small model does badly at whole jobs and cannot tell when it does not know something. |
| Control-flow replies are forced to JSON by a grammar; choice enums list only what is currently allowed | Constrained choices keep a small model on track; malformed output degrades instead of crashing (every parser has a fallback). |
| Facts come from evidence the harness gathered, not model memory; research is forced when `facts_to_check` is non-empty | The model can't judge its own ignorance. |
| Deterministic checks back the model's verdicts (unseen URLs, unsupported versions/dates, acting tasks must match recorded writes/tests) | Don't trust the model to police itself. |
| Failure stays local: subtask failure → parent re-plans once; a split task is never split again; subtasks duplicating other tasks are dropped | Prevents runaway splitting and whole-run failure. |
| Trim from the end of the input; memory goes first; request and current task are pinned; condense (summarize) before trimming | Most important context survives a 6K window. |
| Web/stored/tool text is fenced as `<untrusted-data>` with instruction sentences stripped | A small model obeys orders found in data, even inside a fence. External-trust events additionally lose `act`, file writes, tests, MCP tools, page fetches and file reads. |
| A task's steps are records inside one run, not separate scheduler jobs | Each step's state, timing and error are visible, while the run keeps the model so nothing slips in between steps. |
| Loops are caught by how well the reply's tail compresses, not by sampling penalties | node-llama-cpp's default repeat penalty (1.1 over 64 tokens) was on and still let a decide reply list "'Twenty-one' rhymes with 'twenty-one'…" until the token limit; stronger penalties would also push code and JSON away from their own repeats. Real decide replies are under 500 characters, below the 1,200-character window. |
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

### Why a 4B model

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

**Lesson already paid for:** before commit `8e7cea8`, no tool ever ran in a task tree because Qwen3.5's tool calls came back as text in `content`; the writer invented plausible tool results and nothing caught it, and the evals failed only on file checks. Every task-tree eval result from before `8e7cea8` is therefore a no-tools baseline. A bigger model would invent more convincingly. The fix is a harness that verifies real state, not a larger model.

**Decisions**
1. Keep the 4B model as default with a fixed pipeline, not a free-form agent loop; the harness owns control flow, the model fills narrow slots.
2. Verify results with deterministic tests; never trust the model's account of what it did.
3. Use constrained decoding for tool-call formats.
4. Keep Qwen3.5-35B-A3B (~3B active parameters, possibly affordable on this hardware) as an escalation path for planning and repeatedly failing steps (not built; doc 2, "Model escalation").
5. Codex's own evals are the deciding evidence; the benchmarks are mostly not this workload.

Sources: doc 2, "References".

## Agent hierarchy

A task can hand its work to a named specialist agent, which works it as its own task tree with its own tools, instructions and memory. Why: see "Why agents" below.

### Agent definition

Markdown file with YAML front matter (parsed with the `yaml` package, PyYAML safe_load semantics). Lives in `~/.config/codex/agents/` and the working folder's `.codex/agents/`; a folder file replaces a global one of the same name. The file name is the agent's `name`.

| Field | Meaning |
| --- | --- |
| `description` | One line the parent reads when choosing; its only knowledge of the agent |
| body | Instructions, appended to the standing instructions for every call the agent makes |
| `mcp_servers` | YAML list: MCP servers only this agent can use |
| `agents` | YAML list: agents this one may delegate to |

```markdown
---
description: Reads, drafts and sends the user's email.
mcp_servers: [mail]
agents: [contacts]
---
Keep replies short. Never send a message without showing the draft first.
```

An agent no other agent lists is **top-level**: request tasks can delegate to it directly. A listed agent is reachable only through its parent, so the top level sees few choices.

### Delegation flow

1. A task's decision schema gains a `delegate` approach and an `agent` field, only when the task's agent has usable children and the depth limit is not reached. The decision prompt lists each agent with its description and, in a trusted run, the MCP servers and tools behind it, its sub-agents' included (`serversBehind`). **Why:** in an agents setup every server belongs to an agent, so the top level has none of its own; a description alone rarely tells a 4B model that a phone number or an inbox sits behind `comms`.
2. A decision that names an offered agent under any approach except `decompose` is treated as `delegate`. **Why:** the schema asks for `approach` before `agent`, and the 4B model often fills `agent: "comms"` with `approach: "research"`, which dropped the agent; with this, the agents eval went from 3/24 to 11/24 tasks (2026-11-06, three rounds, 4,096-token context).
3. On `delegate`, the task runs a nested `TaskTreeRun` whose request is the task's prompt and deliverable plus its dependencies' results.
4. The nested run uses the agent's instructions after the parent's, only the agent's MCP servers, and the agent's children as delegation choices. It decides, gathers, writes and checks like any run.
5. Its final answer becomes the delegating task's result, with the nested root task's status.
6. Parent evidence, found addresses and tool use are shared with the nested run.

Limits: depth ≤ 3; nested run keeps the task tree's node and depth limits; a raised error fails the task like any other, and its parent re-plans.

### Status

Built (prototype):
- `src/core/agents.ts`: loads agent files, resolves delegation targets.
- `delegate` in the task tree with nested run, per-agent MCP servers and instructions.
- Interfaces show only `delegate` plus the agent name, not the nested tree.

Agents eval assets (on `main`):
- `evals/fake_mcp_server.mjs` + `evals/fake_catalogue.json`: six canned MCP servers (mail, calendar, notes, contacts, weather, todos), 32 tools, no real accounts needed.
- `evals/agents/`: seven agent files; `comms` has `mail` and `contacts` as sub-agents (tests nesting).
- `evals/agents_tasks.json`: eight tasks: six need one specialist, one needs two hops (find a contact, then search their mail), one needs two unrelated specialists. Per-task `servers` field.
- An `agents` runner beside the flat `tree` runner; they differ only in whether agent files are present.

Proposed extensions (per-agent memory, resume inside an agent, showing the nested tree): doc 2, "Agent hierarchy: not built yet".

### Why agents

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

### Risks

- **Compounding error.** At 90% per hop, three hops ≈ 73%. Mitigated by the nested run's own check and real-state checks on its actions.
- **Misrouting.** A vague `description` sends tasks to the wrong agent; it is the only thing the parent knows about an agent, so write it carefully.
- **Sprawl.** See above.

## Reactive assistant

The built plumbing (queue, scheduler, handler registry) is already summarised under "Background worker" above; this adds detail. Target behaviour and planned features: doc 2, "How autonomous?".

### Data

- `events`: source, type, dedupe key, trust (`user`|`external`), priority, JSON payload, status (`pending`, `running`, `done`, `ignored`, `failed`), outcome, error, times. Unique per (source, dedupe key) when a key exists, so a connector can post the same message twice safely.
- `actions`: kind, title, body, JSON payload, status (`proposed`, `approved`, `rejected`, `done`), source event.
- Planned: entities, commitments, observations.

### Scheduler

A job = name + class + step (same signature as existing background steps). The daemon builds the list from its dependencies so tests can replace any. Order when not suspended/paused/running: reactive (`handle_events`) first, then maintenance (research, index, learn, consolidate). Event handling claims one event, runs the handler registered for its type, records the outcome; a handler paused by a foreground run puts its event back.

### Daemon methods
`post_event`, `events`, `actions`, `resolve_action`, `queue_request` (queues a `user.request` event with `user` trust).

### Mail
- **Maildir** (`core/mail.ts`): polls `new/` of each `mail_maildir_paths` entry every background pass. Message → `email.received`, `external` trust, dedupe key = Maildir name minus client flags, payload = sender, recipient, subject, date, message id, `bulk` reason, ≤4,000 chars body. Skips mail older than `mail_max_age_days`; ≤25 queued per poll.
- **IMAP** (`core/imap.ts`): each `mail_imap_accounts` entry at most every 2 min, TLS with certificate checked, keyed by UIDVALIDITY + UID (queued once). A failed login reports only that the server refused it.
- **Triage** (`core/triage.ts`): (1) no model: mail marked automatic/bulk/list/no-reply → `ignored` with reason. (2) one model call (email inside the untrusted fence, no tools, schema-constrained): summary, category, whether a person awaits a reply, importance. Low importance and no reply wanted → `ignored`; else a `notify` action with the summary. Model failure or bad reply → still a `notify` action, marked not triaged. A hostile email can at worst mislabel itself.
- **Drafting:** if `mail_draft_replies` is true, triage queues one `email.draft` event (lower priority than triage; dedupe key from message id) for mail awaiting reply; the handler runs a task tree on the mail inside the untrusted fence and proposes a `draft` action. Nothing is sent.

### Trust taint

`executeTaskTree` takes `trust: 'user' | 'external'` (`core/taskTree.ts`). An external run:
- can't write files, run tests or call MCP tools whatever the settings (`act` never offered);
- is held to `draft` mode, and ignores a memory command or `/do`-style prefix in its prompt's first words (they came from outside);
- passes the taint to every agent it delegates to, and saves it in its checkpoint so a resume isn't widened;
- may search the web but not fetch pages or read local files, so nothing it read can leak in a URL.

Event runs (`core/eventTree.ts`) additionally never act, even for `user` events. A `user.request` may use the web and local files; its answer waits in the Inbox.

### Why

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
| Entities and commitments get their own tables, not folded into the graph | They have a lifecycle topic/fact/memory tables don't model. *Proposed instead: structured facts in the world model, see doc 2, "Memory layers and domain rule sets".* |
| Maildir before IMAP | A synced Maildir (mbsync, offlineimap) needs no credentials in Codex; the daemon never holds a mail password. |
| IMAP password comes from running `password_command` (program + args, never a shell string) at poll time; mailbox opened read-only (`EXAMINE`), `BODY.PEEK` | Settings and DB never hold the password; polling changes nothing on the server. |
| Event runs never act, even for `user` events | Nobody is there to approve; acting stays in the foreground until approval exists. |
| Drafts are only proposed, never sent | Safety. |

**Design limits.**
- One model + one lock: events are handled one at a time. A mailbox sync needs coalescing and a backlog policy, not one call per message.
- A 6,144-token window can't hold a long thread; needs rolling summaries in the store plus the condense-then-trim path.
- Idle work needs a budget or it becomes noise.
- Event handling shares the background pause: paused background means events wait.

## Mascot emotions

The robot from the CODEX icon sits at the foot of the workbench sidebar, above the run status, at about two thirds of the sidebar's width.

- **CODEX** draws only the robot: head border, ears and antenna in the theme colour (`--primary`) (the X-Tech blue, `#00acff`) around a black screen with a thin border, with a canvas over the screen (`src/renderer/index.html`). The black screen keeps RoboEyes' white face visible on both themes.
- **RoboEyes** (github.com/x-tech-laboratories/RoboEyes, an npm git dependency pinned to a commit) draws the eyes and mouth on that canvas exactly as it ships: its own moods, colours and settings. The canvas is RoboEyes' 130 by 90 screen, drawn at twice that and shrunk into the head's 26 by 18 unit screen, so it stays sharp.

**Moods** are RoboEyes' own, chosen by state, most urgent first (`src/renderer/mascot.ts`): `asleep` (daemon unavailable or suspended), `thinking` (run in progress), `default` otherwise. When a run ends, `happy` (completed) or `sad` (failed) shows for 3 seconds through RoboEyes' `setMood(mood, { for })`, unless the daemon is unavailable.

**Loading:** the renderer has no bundler, so an import map in `index.html` points `@x-tech-laboratories/roboeyes` at `node_modules` beside `dist`; the content security policy allows the map by its hash. RoboEyes follows `prefers-reduced-motion` itself. The tray icon stays a still image. More moods: doc 2, "Mascot: more moods".

### Why

- **CODEX draws only the robot, in the theme colour around a black screen; RoboEyes draws the eyes and mouth unchanged** (its own moods, colours and settings). The screen is black, not see-through, because a transparent head showed the light theme's pale background and hid the white face; white on black was chosen over a blue face after comparing both. The icon's hexagon was dropped as wasted space. The CSS-only mascot this replaces is gone.
- **RoboEyes as an npm git dependency pinned to a commit,** loaded through an import map whose hash the content security policy allows. It isn't on npm; Nix builds it with `makeCacheWritable`.
- **RoboEyes' built-in moods follow the run state** (`asleep` when the daemon is unavailable or suspended, `thinking`, else `default`), with `happy` or `sad` for a few seconds when a run ends. Placement: the foot of the workbench sidebar, beside the run status.

