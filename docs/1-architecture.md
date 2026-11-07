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
- **Tray** (`main/tray.ts`, `main/inbox.ts`, in Electron main not the daemon): menu from daemon status/events; `Inbox (n)` from `actions.changed`; desktop notification for new actions unless the window is in front. `Restart daemon` (tray, window menu, and a button under Options > Desktop) sends `shutdown` and reconnects on the disconnect, which starts a fresh daemon from the window's settings path. Window hides to tray only if a StatusNotifierWatcher exists (checked via `busctl`); a hidden window stays connected so the daemon's unused-exit timer never starts.

### Request flow: task tree

`core/taskTree.ts` holds the tree, the run and the prompts and schemas; each step lives in its own module under `core/steps/` (`decide`, `gather`, `write`, `check`, `subtasks`) as a function that takes the run, and the run's methods of the same names call them. The steps use `model.ts`, `evidence.ts` (search, recall, page summaries), `checks.ts` (non-model checks). Request = task `1` (deliverable: a complete reply); subtasks numbered by path (`1.2.3`). `TaskTree` caps depth (`max_task_depth`) and size (`max_task_nodes`); `TaskTreeRun` works depth-first.

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
- **Tools** (`core/tools.ts`): `web_search` (DuckDuckGo HTML via fetch), `web_fetch` (public addresses only, rechecked after redirects), `list_directory`, `read_file`, `write_file` (needs `allow_file_writes`), `run_tests` (needs `enable_test_execution`). Paths confined to `filesystem_root`; sensitive names refused. `write_file` also refuses the harness's own configuration (`isHarnessPath`, 2026-11-07): any path with a `.codex` part, a file named `CODEX.md` or `AGENTS.md`, and anything under the user's config folder (`configDirectory()`), answering "edit them by hand". **Why:** what is written there loads into every later call, so a fetched page that talked the model into writing an agent, skill or instruction file would persist across runs, event runs included (doc 3, "Architecture improvements"); `/init` writes through the harness, not the tool, so it is unaffected. `list_directory` leaves out the harness's own `.codex` folder (agents, skills, instructions), though `read_file` still opens a file in it by name: listed, `.codex/agents/notes.md` passed for the user's notes in the agents eval. `core/mcpTools.ts` adds MCP-server tools (`@modelcontextprotocol/sdk`) limited to each server's `allowed_tools`. `core/toolStage.ts` runs the gather tool loop: per-approach allow/block list, max `max_tool_calls` (`act` gets at least `MIN_ACT_TOOL_CALLS` = 8, except in a specialist agent's run, which keeps `max_tool_calls`); fetched pages summarized in chunks for a model-supplied focus, then merged. Stop rules: a call repeating an earlier one in the stage (same tool, same arguments with keys sorted) is not run again but answered with the earlier result under "Same call as before; this result is already above. Answer from it now.", and still counts toward the limit; once a connected (`mcp__`) tool has returned a result that is not an error, a round of only repeated calls, or two rounds in a row that call no tool not already used, make the next turn `tool_choice: 'none'`, so the model writes its findings. **Why:** `next-meeting` looped to the tool-call limit after `list_events` had already returned the meeting. Tool calls arrive from node-llama-cpp already parsed. `resolveChatWrapper` picks the Jinja template wrapper for Spark-X2.6-4B (architecture `spark2_5`, no dedicated wrapper) and `QwenChatWrapper` (variation `3.5`) for a Qwen3.5 file; once the model writes the call prefix (`<tool_call>` for Spark, `<tool_call>\n<function=` for Qwen), a grammar limits the name to the offered tools and the arguments to that tool's JSON schema, so arguments are valid and typed by construction. Both wrappers carry the arguments as one JSON object (Spark `<tool_call>NAME<arg_key>params</arg_key><arg_value>{…}</arg_value></tool_call>`, Qwen `<parameter=params>`), not one tag per argument as the models' own templates write them; node-llama-cpp's call syntax has a single slot for the arguments, so the per-argument form cannot be expressed. Phi-4-mini falls back to the generic Jinja wrapper without a usable call syntax, so `core/model.ts` hands it its own `<|tool_call|>[{"name": …, "arguments": …}]<|/tool_call|>` format (chosen when the template has Phi's `<|tool|>` block). `textToolCalls` stays as a fallback for a call left in the reply text (Spark's `<arg_key>`/`<arg_value>` form, Qwen's per-parameter XML form and JSON) and, when the tools were offered, prints `Tool calls arrived as text and were read by textToolCalls: …` to stderr, so a model or wrapper whose calls stop being parsed shows up in an eval log; the eval's `tool_calls` count native calls only, and its `tool_sequence` every call the stage handled, from `runToolStage`'s `onToolCall`. On a `tool_choice: 'none'` turn `textToolCalls` is not called: the reply is the answer as written, and a reply that is only a call block ends the stage with the findings so far under "The model tried to call a tool after being told to answer; the call was not run." **Why:** a call written as text on that turn would otherwise run and undo the stop rules and the call limit.
- **Untrusted text:** sections in `UNTRUSTED_HEADINGS` (search results, stored facts, recalled memory, tool findings, sources, background subtopic summaries, a request being titled), page material sent to the summarizer, and every tool result are wrapped in `<untrusted-data>` tags after stripping any such tag and replacing instruction-giving sentences with `[instruction removed]` (`removeInstructions`). Fencing happens at render time, after trim/condense, so a cut can't drop the closing tag.
- **Deterministic checks** (backing the model's verdict): cited URL absent from captured evidence; after research, a version/date absent from evidence and request (dates compared by value, code-block numbers ignored); an acting task must report what its recorded file writes/test runs really did; when all searches found nothing, the writer is told not to describe what it couldn't look up.

### Knowledge store

`core/knowledge.ts`: one SQLite file (`knowledge_db_path`), WAL, opened per operation via `node:sqlite`, vectors via `sqlite-vec`. Schema versioned by `PRAGMA user_version`; migrations commit with the version bump; a newer database is refused.

| Table | Holds |
| --- | --- |
| `topics` | unique case-insensitive name, `parent_id`, priority, summary, use count, last researched/placed |
| `sources` | URL (unique), title, snippet, page summary, query, topic, retrieved + expiry |
| `facts` | statement under a topic, source, confidence 0–1, status (`active`/`disputed`/`pruned`), use count |
| `user_memory` (the memories) | stores: general, user, locations, software, project, research, code; learned/probed/user-stated; `active`/`superseded` |
| `task_runs` | Checkpoint of an unfinished task tree (prompt, title, options, state, status, tasks done/total) so it resumes after a restart |
| `episodes` | each finished request: prompt, title, mode, checklist/tree outline, answer, outcome, tree snapshot |
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
        pollConnectors | handleNextEvent | titleConversations | researchOneTopic | indexKnowledge (CPU embedding model)
        | learnFromEpisodes | consolidateKnowledge
      worked → wait 0.2 s, else poll interval
```

- **Events:** `MailConnector` (`core/mail.ts`, Maildir folders in `mail_maildir_paths`) and `ImapConnector` (`core/imap.ts`, `mail_imap_accounts`) queue events. `handleNextEvent` (`core/events.ts`) claims the most important event and runs its type's handler: `notify` → proposed action; `email.received` → triage (`core/triage.ts`); no handler → `ignored`. `email.draft` and `user.request` are worked as task trees (`core/eventTree.ts`): holds the model lock, stops when foreground work arrives (event requeued), result becomes a `draft`/`result` action. A tree from an `external`-trust event runs with `trust: 'external'`: no `act`, file writes, test runs or MCP tools; research may search but not fetch pages or read files. Interfaces use `post_event`, `events`, `actions`, `resolve_action`. Detail: "Reactive assistant" section below.
- **`researchOneTopic`** (`core/background.ts`): claim highest-priority job; `web_search` the topic, fetch + summarize the first two distinct pages (skip near-duplicate text); number all page summaries and snippets as sources; extract ≤5 facts per page and from snippets together, each with source number and `low|medium|high` confidence (0.3/0.6/0.9), in small groups so one failure loses only its own; drop facts stating a version/date absent from all sources, and demote to low confidence facts whose values or half their words are missing from the cited source (or that cite none); one overview call yields topic summary + ≤5 entity relationships (drop summary sentences with unsupported versions/dates); store all. Tree placement is left to consolidation. Paused job → `pending`; other error → `failed` with message; jobs left `running` by a dead daemon → `pending` at next start.
- **Titles** (`core/titles.ts`): one module holds what a title is (1–5 words, ≤40 chars, sharing a word with the text it names), the two title prompts (topic and conversation), the reply parser and a no-model fallback (the request's first words). `titleConversations` titles one conversation per pass, unfinished task runs before episodes, newest first: one schema call on the request (≤1,500 chars, fenced as untrusted); a failed, too long or ungrounded reply stores the fallback so it is never asked again; a pause stores nothing. The unfinished-run bar shows the title once there is one.
- **`learnFromEpisodes`:** ≤5 unprocessed episodes → durable preferences, projects, corrections (secrets and personal identifiers explicitly excluded) plus ≤3 general subjects worth researching (queued if no facts yet). Episodes marked processed even on failure so one bad batch can't block.
- **Consolidation** (`core/consolidation.ts`): one small step per pass so it yields fast.
  1. No model (`KnowledgeStore.tidy`): break topic parent loops; merge topics with same words and facts differing only in case/punctuation; remove empty topics; mark never-recalled low-confidence facts `pruned` after `background_prune_after_days`; past `background_max_store_megabytes` delete least valuable first (pruned facts, finished task runs, processed episodes, expired uncited sources, least used facts) with their search entries/vectors until under 90% of cap.
  2. One model call per pass, in order: topic-name check (title rules and prompt from `core/titles.ts`; rename to ≤5-word title, folding into an existing same-name topic and requeueing research; or remove if no subject, no facts, only sentence-length searches found it; applies to each researched topic once and any name >5 words/40 chars); compare two topics (same / one broader / different); re-place a topic under the narrowest of ≤20 related topics, the top level, or a new broader subject (a move under an existing topic needs a second pair-comparison call to agree it is broader); compare two facts in one topic (same / contradict / different); compare two memories in one store. Candidates must share ≥half their words, or (topics, and facts under one topic) have embedding cosine ≥ 0.75. Replies are a short reason + schema-enum verdict, stored in `consolidation_checks` so each pair is asked once.
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
- **Task graph** (`renderer/taskGraph.ts`, force-graph): the Workbench's Graph toggle shows the run's tasks as boxes coloured by state, one row per tree level, each task's steps as a chain of smaller boxes beneath it, subtasks hanging from the step that planned them, and dashed "builds on" arrows only for the chosen or pointed-at task. It starts shown, updates live from the tree snapshots, and has a Reset view button that refits the whole tree after panning or zooming. Clicking a task opens its details; clicking a step also scrolls to that step's prompt and output (steps are matched by name and by how many of the same name came before it).
- **Evals** (`core/evaluation.ts`): the bare model against the harness on a fixed task set, and with the store empty against filled. `evals/reasoning_tasks.json` (25 tasks, prompts from the MIT-licensed Questions-for-AI-Model-Testing repo, notice beside it) tests reasoning and intelligence: trick questions, decimal comparisons in both orders, letter counts, order of operations, a clock angle, and three questions that need current or estimated figures. **Why:** the agents eval measures tool use; model choice also needs a measure of whether a model reasons its way past the well-known traps that small models fall into. A recall benchmark scores recall against fixed questions with known relevant facts (`core/recallBenchmark.ts`). `--stream` prints each step, hand-over and tool call of a run as it happens. Per run, `--output` keeps `tool_calls` (every native call, name and arguments) and beside it `agents` (each hand-over in order: agent, parent agent or null at the top, depth) and `tool_sequence` (every call the tool stage ran or refused, in order, with the agent whose run made it, its depth, `valid` and `error`), from the task tree's `delegationCallback` and `toolCallCallback`, which `delegate()` hands down to every nested run. A call is `valid` when it names a tool offered in that stage and its arguments pass the tool's JSON schema (ajv, through the MCP SDK's validator), and `error` when its result was a tool error, a refusal or the call limit. A task may name `expect_servers`; a run's `tool_choice` is then whether it made a valid call on each of those servers, and every agents task names them. The summary adds per runner pass^k (distinct tasks passed in every round they ran) beside the pooled rate, valid and failed call counts, and tool-choice accuracy; the console prints pass^k beside the pooled rate and a table of passes per task and runner. `--compare OLD` pairs each task and runner of the run with an earlier `--output` file (`--against NEW` pairs two files without loading the model): passes on each side, biggest change first and tasks in only one file last, pooled and pass^k totals, and how many tasks got better or worse; it reads only `task_id`, `runner` and `passed`, so files saved before these fields existed still compare. **Why:** with eight tasks a pooled rate moves by chance, and the evidence on eval noise (doc 2, question 9) favours pass^k and paired per-task differences, with tool choice as the per-step measure the harness controls; reading per-task counts out of the file by hand was slow and error-prone. `evals/run_model_trial.sh` runs the model assessment protocol (the agents, scaled and reasoning sets, or any one of them) for one GGUF under the GPU lock, and the raw results of the Spark/Qwen trials are kept in `evals/results/`. **Why:** a run reports only when it ends, so a Phi-4-mini smoke run looped for 18 minutes on one task before anyone could see what it was doing.
- **Tests of note:** untrusted-text fencing against hostile pages; schema migrations from every earlier store version.

### Why it is built this way

| Decision | Why |
| --- | --- |
| TypeScript on Node 24 with node-llama-cpp and one Electron window (tray included); ported from Python, landed 2026-11-05 at `5942075` | One Electron app in place of three Python interfaces (Textual TUI, GTK app, CLI). The Python code is deleted. |
| Never give the model the whole job; work requests as a tree of narrow tasks | A small model does badly at whole jobs and cannot tell when it does not know something. |
| Control-flow replies are forced to JSON by a grammar; choice enums list only what is currently allowed | Constrained choices keep a small model on track; malformed output degrades instead of crashing (every parser has a fallback). |
| Facts come from evidence the harness gathered, not model memory; research is forced when `facts_to_check` is non-empty | The model can't judge its own ignorance. |
| What a connected (MCP) tool returned counts as evidence: once one was called, writing steps get `CONNECTED_EVIDENCE_RULE` and never the "every search failed" rule | Otherwise a task that found the user's contact or email through MCP and then searched the web empty-handed said it had no evidence (agents eval, `priya-last-email`). |
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
| Topics and conversations share one title module; conversations are titled in idle time, not when the run starts | One set of rules for every title the user sees; a title call before a run would delay every request by a model call (~4 s). |
| A conversation title must share a word with its request, else it is the request's first words | A small model's title may describe something the request never asked about. |
| Separate CPU-only backend when `gpu_layers` is 0; optional separate background model | A CUDA build touches the GPU even with no layers; a background model must not evict the main one. |
| GPU lock is a kernel `flock` held by a child process, shared with other programs | Released automatically if the daemon dies; the GPU is shared. |
| `learnFromEpisodes` must exclude secrets and personal identifiers | Privacy of stored memory. |

### Measured limits (dev laptop: RTX 3050 Ti Mobile 4 GB, Ryzen 5 5600H, 27 GiB RAM; display on iGPU)

- **Context ceiling 6,144 tokens** with `Qwen3.5-4B-UD-Q4_K_XL` fully on GPU. 7,168–10,240 loads but the process aborts with a CUDA error on a long prompt; ≥12,288 can't create a context. A context that loads is no proof it fits. 560 MiB fixed reserve in `core/autoSize.ts` is fitted to this (2026-10-20). Measured with Qwen; not yet repeated for Spark-X2.6-4B, the reference since 2026-11-07, which fits fully at 6,144 tokens in 3,475 MiB.
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

### Reference model: Spark-X2.6-4B

`models/model.gguf` points at `Spark-X2.6-4B-Q4_K_M.gguf` (SparkLLM, Apache 2.0, architecture `spark2_5`, 4.4B parameters, 3.54 GB) since 2026-11-07. Qwen3.5-4B-UD-Q4_K_XL was the reference before; its files and Phi-4-mini's were deleted that day ([done-phi-4-mini-as-generalist.md](done/done-phi-4-mini-as-generalist.md)). The embedding model is still Qwen3-Embedding-0.6B (an open decision, doc 3, "Model choice").

**Why:** on the same builds, through the assessment protocol (doc 3, "Model results"):

| Set, runner | Spark-X2.6-4B | Qwen3.5-4B |
|---|---|---|
| agents, `tree` | 19/24 | 19/24 |
| agents, `agents` | 17/24 | 6/24 |
| reasoning, `bare` | 59/75 | 57/75 |
| reasoning, `tree` | 70/75 | 73/75 |
| seconds per model call | 2.0–2.7 | 3.7–4.3 |

Under the protocol this is a trade-off, not a win: far better tool use through agents and about half the time per call, against 3 fewer reasoning tasks of 75 with the harness, within round-to-round noise. The user chose Spark on that trade-off.

- **Fit and speed:** all 37 layers on CUDA at 6,144 tokens use 3,475 MiB of 3,773 (Qwen used 3,627); 46.6 tok/s on a 120-token reply.
- **Tool calls:** native calls from node-llama-cpp, plus a text form `<tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>` that `textToolCalls` reads (Tools, above).
- **Known misses:** `bare` runs past `max_tokens` (1,536) on `country-ending-in-lia` and `number-rhyming-with-tree`; `tree` is unsteady on `boiling-eggs`, `number-rhyming-with-tree` and `order-of-operations`.
- **Not yet measured for Spark:** the context ceiling and the 560 MiB reserve in `core/autoSize.ts`, both fitted to Qwen (Measured limits).
- **Outside evidence:** vendor figures only (BFCL-V4 71.8, τ²-bench 86.9, MCP-Atlas 62.4); Artificial Analysis does not list it.

## Agent hierarchy

A task can hand its work to a named specialist agent, which works it as its own task tree with its own tools, instructions and memory. Why: see "Why agents" below.

### Agent definition

Markdown file with YAML front matter (parsed with the `yaml` package, PyYAML safe_load semantics). Lives in `~/.config/codex/agents/` and the working folder's `.codex/agents/`; a folder file replaces a global one of the same name. The file name is the agent's `name`.

**Starter set, on by default (2026-11-07).** `share/agents/` ships 30 agents: 26 leaves, one per common personal-assistant domain, each owning the MCP server of its own name (`mail`, `calendar`, `contacts`, `notes`, `todos`, `weather`, and since the scaled eval `files`, `bookmarks`, `music`, `photos`, `lights`, `thermostat`, `shopping`, `recipes`, `fitness`, `bank`, `travel`, `maps`, `news`, `translate`, `timers`, `packages`, `car`, `health`, `library`, `vault`), and four parents with no server of their own: `comms` over `mail` and `contacts`, `home` over `lights` and `thermostat`, `media` over `music` and `photos`, and `meals` over `recipes` and `shopping`. That leaves 22 choices at the top and depth 2. The leaf descriptions name what each domain holds rather than verbs, so the domains that sound alike stay apart: `files` (stored documents) against `notes` and `bookmarks`, `timers` (timers and alarm clocks) against `calendar` reminders, `health` (doctor appointments) against `calendar`, `fitness` against `health`. `vault` reads only a password manager's metadata. `installStarterAgents` (`core/agents.ts`), called when the daemon or the CLI starts, copies them into `~/.config/codex/agents/` only when that folder does not exist; a folder the user has made, even an empty one, is left alone, so deleting a starter agent sticks. The same files are what the agents eval copies into its workspace, so the eval measures the shipped set. **Why:** the hierarchy beat the flat tree on Spark (24/24 against 19/24, doc 3, "Model results"), and a fresh install that had to write agent files by hand would run the losing configuration.

**Usable agents only.** `usableAgents` (`core/agents.ts`) filters the loaded agents at the start of every run: an agent is kept if it, or an agent behind it, owns a connected and enabled MCP server, or if it names no server at all (an instructions-only agent); the rest are dropped and removed from their parents' `agents` lists. So a starter agent is dormant until a server of its name is configured, and `comms` is offered as soon as either `mail` or `contacts` is. **Why:** the parent chooses from descriptions alone, so an agent with no tools behind it would be chosen and then fail. The 8-task agents set connects only the original six fake servers, so the filter offers it the original seven agents and its runs are unchanged; the scaled set connects all 26, so every agent is offered.

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
2. **Routing comes first.** A task with agents to choose from first makes one `Routing` call (`ROUTING_PROMPT`, `routingSchema`): which agents does the task need, any number, each with one sentence of its part, in the order the parts must happen. One agent → `delegate` with no `decide` call; two or more (with room for subtasks) → `decompose` into one subtask per agent, prompt "<part> (for the <agent> agent)", each depending on every earlier part and naming its agent in the task's `agent` field (saved in checkpoints; an older checkpoint reads as none), so the subtask delegates straight away with no `Routing` or `decide` call while that agent is still offered; none, a bad reply or a failed call → the usual `decide`. A top task that may still ask its clarifying question gets the `clarification` field here too. **Why:** a task that needs two agents reached them only if the model first chose `decompose`, which it rarely did (`free-slot-and-weather` 0/3 in agents runs); picking agents from a list is easier for a 4B model than judging whether a task is big. A routed subtask that went through `decide` again made a second routing call that could send it elsewhere.
3. A decision that names an offered agent under any approach except `decompose` is treated as `delegate`. **Why:** the schema asks for `approach` before `agent`, and the 4B model often fills `agent: "comms"` with `approach: "research"`, which dropped the agent; with this, the agents eval went from 3/24 to 11/24 tasks (2026-11-06, three rounds, 4,096-token context).
4. On `delegate`, the task runs a nested `TaskTreeRun` whose request is the task's prompt and deliverable plus its dependencies' results. The request the user typed goes with it as a pinned section, `USER_REQUEST_LABEL` ("The user's own request (context: other tasks cover the rest of it)"), handed down unchanged through every level. **Why:** the brief is written by a 4B model; without the user's words an agent had nothing to read a vague or wrong brief against.
5. The nested run uses the agent's instructions after the parent's, only the agent's MCP servers, and the agent's children as delegation choices. An agent with MCP servers and no sub-agents is a **specialist**: its top task skips `decide` and goes straight to `act`, and a failed check is not split but handed back, so the parent re-plans. Any other agent decides, gathers, writes and checks like any run. **Why:** on `inbox-newest` Phi-4-mini's agent run never called a tool and kept splitting its one part (Task 1.2.1.2); planning belongs to the run that handed the part over (MAKER: the atomic step is one agent using its tools).
6. Its final answer becomes the delegating task's result, with the nested root task's status.
7. **Re-route once.** After the hand-over, a task routes one more time when its result is not `done`, or when it is the top task of a non-specialist agent's run (such as `comms`) and routing named one agent. The call offers only the agents not used yet, shows the agent's result under "Action results from the <agent> agent" and adds `REROUTE_NOTE` ("List only the agents still needed; leave 'needs' empty if the task is complete."). If it names one, the task becomes a `decompose` with two subtasks: the finished hand-over as subtask 1 and "<part> (for the <agent> agent)" as subtask 2, depending on 1, so the second agent gets the first result in its brief and the usual combine and check join both. A routed subtask, a specialist's task and a task without room for two subtasks are not re-routed, so each task routes again at most once. **Why:** inside `comms`, routing named `contacts` alone for `priya-last-email`, and the run stopped after finding the address; reusing the subtask machinery needs no second execution model.
8. Parent evidence, found addresses and tool use are shared with the nested run.

Limits: depth ≤ 3; nested run keeps the task tree's node and depth limits; a raised error fails the task like any other, and its parent re-plans.

### Status

Built (prototype):
- `src/core/agents.ts`: loads agent files, resolves delegation targets.
- `delegate` in the task tree with nested run, per-agent MCP servers and instructions.
- Interfaces show only `delegate` plus the agent name, not the nested tree.

Agents eval assets (on `main`):
- `evals/fake_mcp_server.mjs` + `evals/fake_catalogue.json`: 26 canned MCP servers, 116 tools, no real accounts needed. The server takes its name as its argument and serves that catalogue entry; each tool returns one fixed reply whatever its arguments, and the people and places in the replies are made up. The first six (mail, calendar, notes, contacts, weather, todos, 32 tools) are the original set; the 20 added for the scaled set have 3 to 6 tools each, and nine of them have a tool named plain `search` (files, bookmarks, music, photos, recipes, bank, maps, news, library), so the flat list has many tools that sound alike. `FAKE_SERVERS` (`core/evaluation.ts`) is the catalogue's server names, and a task's `"servers": "all"` gets all of them.
- `share/agents/`: the shipped starter agents (above), 30 files; `comms`, `home`, `media` and `meals` each have two sub-agents (tests nesting).
- `evals/agents_tasks.json`: eight tasks: six need one specialist, one needs two hops (find a contact, then search their mail), one needs two unrelated specialists. Each task names the original six servers, so the set stays the baseline it was measured as, and `expect_servers` names the servers a right answer needs, which scores tool choice.
- `evals/scaled_tasks.json` (2026-11-07): 22 tasks with all 26 servers connected, each with `expect_servers` like the 8-task set: seven need one server, seven need two, eight need three or four. Some chain (the breached login names the company whose payment the bank search finds; the trip names the flight to look up), some combine unrelated parts (alarm, sleep and forecast). This is the set meant to show where the flat tree and the hierarchy part: the flat list is 116 tools, about 26,600 characters of definitions.
- An `agents` runner beside the flat `tree` runner; they differ only in whether agent files are present. The flat tree is not a second design but the hierarchy with zero agents, which is what a run sees when no agent's server is connected.

Proposed extensions (per-agent memory, resume inside an agent, showing the nested tree): doc 2, "Agent hierarchy: not built yet".

### Why agents

**Hypothesis to test.** A small model (a 4B model on a 4 GB GPU) chooses and uses tools more reliably when it sees only one specialist's few tools than when it sees every tool at once. Agents are kept only if they beat the flat tree on tool tasks (see roadmap).

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
| Nested run receives the task's prompt, deliverable and dependency results, with the user's own request as a pinned section (Delegation flow, step 4) | The brief keeps the specialist's context narrow; the user's words let it read a vague or wrong brief against them. |
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
- `mail_outcomes`: one row per triaged message: event, notify action and draft action ids, sender address, subject, message id, triage class (`ignore`, `notify`, `reply`), who decided it (`heuristic` = bulk headers, `rule`, `model`, `fallback` = model failed), reason (rule, or category, importance and summary), the user's resolution (`pending`, `ignored` for mail triage dropped, then `approved`/`rejected`/`done` from `resolve_action`), the draft text, the names of the draft checks it failed, the draft's resolution, and timestamps. `edited_draft` and `edit_distance` exist but stay null: no path returns an edited draft yet. Written by triage and the draft handler; `resolve_action` fills in the answer in the same transaction as the action. This is the mail domain's success signal and past-case set (doc 2, "Self-improving domains").
- `mail_sender_rules`: pattern (a whole address or a bare domain, lower-cased), class, origin (`user`|`learned`), created, hit count. A user-visible table, not a rule engine.
- Planned: entities, commitments, observations.

### Scheduler

A job = name + class + step (same signature as existing background steps). The daemon builds the list from its dependencies so tests can replace any. Order when not suspended/paused/running: reactive (`handle_events`) first, then maintenance (research, index, learn, consolidate). Event handling claims one event, runs the handler registered for its type, records the outcome; a handler paused by a foreground run puts its event back.

### Daemon methods
`post_event`, `events`, `actions`, `resolve_action`, `queue_request` (queues a `user.request` event with `user` trust).
Mail: `mail_outcomes` (`limit`, `since` in epoch seconds) returns recent outcome rows and a summary: per class how many were decided, kept (`approved`/`done`), dismissed (`rejected`) and pending; draft counts and how many failed a check; `agreement`, the share of shown mail kept rather than dismissed; and `rule_conflicts`, past decisions not made by a rule that today's rules would class otherwise. `sender_rules`, `set_sender_rule` (`pattern`, `mail_class`; returns the rule and how many past decisions it disagrees with), `delete_sender_rule` (`pattern`). None of these are on the window's allowed list; the window only shows rule proposals in the Inbox.

### Mail
- **Maildir** (`core/mail.ts`): polls `new/` of each `mail_maildir_paths` entry every background pass. Message → `email.received`, `external` trust, dedupe key = Maildir name minus client flags, payload = sender, recipient, subject, date, message id, `bulk` reason, ≤4,000 chars body. Skips mail older than `mail_max_age_days`; ≤25 queued per poll.
- **IMAP** (`core/imap.ts`): each `mail_imap_accounts` entry at most every 2 min, TLS with certificate checked, keyed by UIDVALIDITY + UID (queued once). A failed login reports only that the server refused it.
- **Triage** (`core/triage.ts`): (0) sender rules: the sender's address is looked up in `mail_sender_rules`, the exact address before its domain (no subdomain matching); a match decides the class without the model, even for bulk mail, counts a hit, and is the recorded reason (`ignore` → `ignored`; `notify` → a `notify` action; `reply` → a `notify` action and a draft). (1) no model: mail marked automatic/bulk/list/no-reply → `ignored` with reason. (2) one model call (email inside the untrusted fence, no tools, schema-constrained): summary, category, whether a person awaits a reply, importance. Low importance and no reply wanted → `ignored`; else a `notify` action with the summary. Model failure or bad reply → still a `notify` action, marked not triaged. A hostile email can at worst mislabel itself.
- **Drafting:** if `mail_draft_replies` is true, triage queues one `email.draft` event (lower priority than triage; dedupe key from message id, payload carries the outcome row id) for mail awaiting reply; the handler runs a task tree on the mail inside the untrusted fence and proposes a `draft` action whose payload names the recipient (the sender's address) and subject (`Re: <subject>`). Nothing is sent.
- **Draft checks** (`core/mailChecks.ts`, no model): the recipient is the sender or another address in From/To; the subject equals the thread's after stripping `Re:`/`Fwd:`; no date, weekday, time, money amount or capitalised mid-sentence word (mostly names) that appears nowhere in the thread's headers and body, reusing `unsupportedValues` from `checks.ts` for full dates. A `To:` or `Subject:` line the model wrote at the top of its draft is checked in place of the ones the harness sets. A failing draft is still proposed; its body ends with a `Check:` line naming what failed, and the outcome row lists the failed checks. Known false positives: the owner's own name in a sign-off within a sentence, product or place names, a time written differently (`3pm` vs `15:00`), a relative date the thread implied. Missed: a wrong name that happens to occur in the thread, numbers without a currency, dates written as `5/11`.
- **Rule proposals:** when the user dismisses (`rejected`) a shown message and the sender's last `mail_rule_proposal_threshold` (default 3; 0 turns it off) resolved messages were all dismissed, `resolve_action` proposes a `rule` action, "Ignore mail from <address>?", saying how many past decisions it would change. Marking it Done adds a `learned` rule; Dismiss declines, and that address is never proposed again. Nothing is written without the user's answer (doc 2, "Fact and rule engine": a rule is stored only after user approval). Only `ignore` is proposed; keeping mail does not propose a rule.

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
| Mail outcomes are their own table, not columns on `actions` | A message has zero to two actions (none when ignored, a notify, maybe a draft), and an ignored message still needs a row; `actions` serves every event kind. One row per message keeps the triage decision, draft and both answers together for replay. |
| Sender rules are a small table checked before the model, not a rule engine | Doc 2's decision: build the data and plain-predicate checks first, and build a general engine only if they move triage agreement. |
| Draft checks note, never block or fix | They are lexical and have false positives; the user reads every draft anyway. |

**Design limits.**
- One model + one lock: events are handled one at a time. A mailbox sync needs coalescing and a backlog policy, not one call per message.
- A 6,144-token window can't hold a long thread; needs rolling summaries in the store plus the condense-then-trim path.
- Idle work needs a budget or it becomes noise.
- Event handling shares the background pause: paused background means events wait.

## Mascot emotions

The robot from the CODEX icon sits at the foot of the workbench sidebar, above the run status, at about two thirds of the sidebar's width.

- **CODEX** draws only the robot: head border, ears and antenna in the theme colour (`--primary`) (the X-Tech blue, `#00acff`) around a black screen with a thin border, with a canvas over the screen (`src/renderer/index.html`). The black screen keeps RoboBuddy' white face visible on both themes.
- **RoboBuddy** (github.com/x-tech-laboratories/RoboBuddy, an npm git dependency pinned to a commit) draws the eyes and mouth on that canvas exactly as it ships: its own moods, colours and settings. The canvas is RoboBuddy' 130 by 90 screen, drawn at twice that and shrunk into the head's 26 by 18 unit screen, so it stays sharp.

**Moods** are RoboBuddy' own, chosen by state, most urgent first (`src/renderer/mascot.ts`): `asleep` (daemon unavailable or suspended), `thinking` (run in progress), `default` otherwise. When a run ends, `happy` (completed) or `sad` (failed) shows for 3 seconds through RoboBuddy' `setMood(mood, { for })`, unless the daemon is unavailable.

**Loading:** the renderer has no bundler, so an import map in `index.html` points `@x-tech-laboratories/robobuddy` at `node_modules` beside `dist`; the content security policy allows the map by its hash. RoboBuddy follows `prefers-reduced-motion` itself. The tray icon stays a still image. More moods: doc 2, "Mascot: more moods".

### Why

- **CODEX draws only the robot, in the theme colour around a black screen; RoboBuddy draws the eyes and mouth unchanged** (its own moods, colours and settings). The screen is black, not see-through, because a transparent head showed the light theme's pale background and hid the white face; white on black was chosen over a blue face after comparing both. The icon's hexagon was dropped as wasted space. The CSS-only mascot this replaces is gone.
- **RoboBuddy as an npm git dependency pinned to a commit,** loaded through an import map whose hash the content security policy allows. It isn't on npm; Nix builds it with `makeCacheWritable`.
- **RoboBuddy' built-in moods follow the run state** (`asleep` when the daemon is unavailable or suspended, `thinking`, else `default`), with `happy` or `sad` for a few seconds when a run ends. Placement: the foot of the workbench sidebar, beside the run status.

