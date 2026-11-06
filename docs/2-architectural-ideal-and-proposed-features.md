# Architectural ideal and proposed features

Paths are under `src/`. Built/not-built statuses were checked against the code on 2026-11-06 (table names, approaches, daemon methods, window pages, eval assets, and the absence of every "proposed" mechanism); behaviour details were not re-tested. Built parts are not fixed either: doc 1, "Open strategic questions", lists where the design may change.

## Core architecture (built)

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
- **GPU lock** (`core/gpuLock.ts`): exclusive `flock` on `$XDG_RUNTIME_DIR/codex-gpu.lock`, shared with other programs, held by a child `flock` process so the kernel frees it if the daemon dies. `CODEX_GPU_LOCK` overrides the path or disables (empty). Inherited descriptor is reused under `flock`.
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
- **Input section order** (most important first; trimming cuts from the end so memory goes first): original request, current task + deliverable, date, correction, call's own material, clarification, dependency results, gathered evidence, tree outline, recalled memory.

### Shared machinery

- **Model calls** (`runStage`): one system prompt + one user message, streamed; optional JSON schema → grammar. Qwen thinking off via chat wrapper. Decisions, checks and background extraction always use a schema; every parser has a malformed-reply fallback (degrade, don't crash).
- **Context budget** (`core/contextBudget.ts`): token counts from the model's tokenizer. Budget = context − reply budget (1024 decisions, 512 checks) − system prompt − template reserve. On overflow: largest unpinned sections are summarized first (each once per run, cached), then trimmed. Request and current task are pinned.
- **Tools** (`core/tools.ts`): `web_search` (DuckDuckGo HTML via fetch), `web_fetch` (public addresses only, rechecked after redirects), `list_directory`, `read_file`, `write_file` (needs `allow_file_writes`), `run_tests` (needs `enable_test_execution`). Paths confined to `filesystem_root`; sensitive names refused. `core/mcpTools.ts` adds MCP-server tools (`@modelcontextprotocol/sdk`) limited to each server's `allowed_tools`. `core/toolStage.ts` runs the gather tool loop: per-approach allow/block list, max `max_tool_calls`; fetched pages summarized in chunks for a model-supplied focus, then merged.
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
- **Evals** (`core/evaluation.ts`): the bare model against the harness on a fixed task set, and with the store empty against filled. A recall benchmark scores recall against fixed questions with known relevant facts (`core/recallBenchmark.ts`).
- **Tests of note:** untrusted-text fencing against hostile pages; schema migrations from every earlier store version.

## Agent hierarchy

A task can hand its work to a named specialist agent, which works it as its own task tree with its own tools, instructions and memory. See [rationale](1-rationale-and-decisions.md#agent-hierarchy) for why.

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

1. A task's decision schema gains a `delegate` approach and an `agent` field, only when the task's agent has usable children and the depth limit is not reached.
2. On `delegate`, the task runs a nested `TaskTreeRun` whose request is the task's prompt and deliverable plus its dependencies' results.
3. The nested run uses the agent's instructions after the parent's, only the agent's MCP servers, and the agent's children as delegation choices. It decides, gathers, writes and checks like any run.
4. Its final answer becomes the delegating task's result, with the nested root task's status.
5. Parent evidence, found addresses and tool use are shared with the nested run.

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

Proposed, not built:
- **Per-agent persistence:** a memory scope per agent in the knowledge store, filled by learning from that agent's episodes, plus a scratchpad folder under the state directory.
- **Resume inside an agent:** checkpoints save the delegating task, not the nested run, so a resume restarts the delegation.
- **Show the nested tree** in the interfaces.
- **Per-agent skills and tool allow lists** beyond MCP servers.

## Reactive assistant

The built plumbing (queue, scheduler, handler registry) is already summarised under "Background worker" above; this adds detail.

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

### The ideal (target behaviour)

An assistant that notices, prepares and asks, and acts alone only where the user has said it may.
- **Many sources, one queue:** mail, calendar, files, timers, webhooks post events; the same queue, scheduler and Inbox serve them.
- **Work shaped like the event:** cheap triage first; a task tree only if needed; result is a draft, filed item, calendar entry or nothing.
- **Autonomy ladder per event class:** approving moves a class up, a rejection moves it down; rules are stored as memories the user can read and delete.
- **Untrusted text never steers:** fenced, read with no tools or the narrowest set, can't widen its own permissions.
- **Model of the user's world:** people, threads, commitments with a lifecycle (open/done/overdue), so "who am I waiting on" and "what did I promise" have answers.
- **Idle time with a purpose:** meeting pre-research, stale-commitment sweep, entity profiles from past requests, daily digest; pruning/consolidation as upkeep, not the main job; budgeted.
- **Always yields to the user:** a foreground request takes the model from any background run within one call.

### Planned features
- **Approval and autonomy ladder** (observe → notify → draft → act with approval → act unattended; rules learned from approvals/rejections). Until it exists no event run can change anything.
- **Entities and commitments** (as structured facts in the world model, see "Fact and rule engine"), then idle jobs driven by them: pre-research for tomorrow's meetings, stale-commitment sweeps, entity profiles from episodes, daily digest.
- Other connectors: calendar, tasks/to-dos, bookmarks, notes, file watchers, timers, webhooks.
- Mailbox coalescing / backlog policy; rolling thread summaries; idle-work budget.

## Model escalation (proposed)

Default to the 4B model in a fixed harness-owned pipeline. Proposed: escalate planning and steps that fail repeatedly to Qwen3.5-35B-A3B (~3B active parameters). Not built. See rationale doc, "Is a 4B model enough?".

## Voting and red-flagging (proposed, from MAKER)

Sample a step several times and decide by first-to-ahead-by-K voting; discard confused answers (too long, badly formatted) before they vote and resample. Candidate for control-flow calls (decisions, checks) where replies are schema-constrained and cheap. Not built. Evidence is from one perfectly verifiable domain; test on Codex's own evals before adopting.

## Mascot emotions (built)

The robot from the CODEX icon sits at the foot of the workbench sidebar, above the run status, at about two thirds of the sidebar's width.

- **CODEX** draws only the robot: head border, ears and antenna in the theme colour (`--primary`) (the X-Tech blue, `#00acff`) around a black screen with a thin border, with a canvas over the screen (`src/renderer/index.html`). The black screen keeps RoboEyes' white face visible on both themes.
- **RoboEyes** (github.com/x-tech-laboratories/RoboEyes, an npm git dependency pinned to a commit) draws the eyes and mouth on that canvas exactly as it ships: its own moods, colours and settings. The canvas is RoboEyes' 130 by 90 screen, drawn at twice that and shrunk into the head's 26 by 18 unit screen, so it stays sharp.

**Moods** are RoboEyes' own, chosen by state, most urgent first (`src/renderer/mascot.ts`): `asleep` (daemon unavailable or suspended), `thinking` (run in progress), `default` otherwise. When a run ends, `happy` (completed) or `sad` (failed) shows for 3 seconds through RoboEyes' `setMood(mood, { for })`, unless the daemon is unavailable.

**Loading:** the renderer has no bundler, so an import map in `index.html` points `@x-tech-laboratories/roboeyes` at `node_modules` beside `dist`; the content security policy allows the map by its hash. RoboEyes follows `prefers-reduced-motion` itself. The tray icon stays a still image.

**Not built:** more states mapped to moods. Candidates (state in `src/renderer/runState.ts`): a clarification or approval waiting (`clarifications` not empty; curious), background research working (`backgroundStatus` not `Idle`; focused), daemon unreachable (`connection: 'unavailable'`; worried, today `asleep`), the user cancelling (`cancelling`; startled), resuming from suspend or connecting at launch (waking), a final answer arriving (`phase: 'final'`; excited). Needs a priority order when several hold at once (e.g. worried, asleep, startled, curious, thinking, focused, calm), with happy/sad/excited as brief moments rather than states. The removed CSS mascot also had an antenna pulse while thinking, floating z's while asleep and a slow head bob (git history); RoboEyes draws none of these.

## Speech output (proposed)

Give the mascot a voice: a TTS engine feeds RoboEyes' `speakVisemes` with real phonemes and durations, and a mood value drives eyes, mouth and voice together. Engine choice and trade-offs are in the rationale doc ("Text-to-speech"). Chatterbox would be an optional backend behind a small local server on a machine with enough VRAM; the dev laptop's 4 GB GPU is shared with the main model (see GPU lock), so voice must not compete for it. Not built.

## Core structure ideas (proposed unless noted)

Rationale, caveats and how each compares with the built design are in doc 1 ("Core structure ideas"). Checked 2026-11-06: none is built.

### Blueprints: deterministic task graphs

Hard-coded task graphs for requests whose shape is known (e.g. "process my morning inbox": fetch unread, loop in code, one item plus a strict schema per model call, deterministic summary). The model never plans these; it fills one narrow slot per node. Mail triage and drafting already work this way. Open: whether blueprints become the main way requests are worked, with `decide` as the fallback for requests no blueprint covers, or stay a few special cases (doc 1, open question 1). A rule engine could choose the blueprint (see "Fact and rule engine").

### Model-planned task graphs

For requests no blueprint fits, the model's first turn emits a JSON task graph of atomic items and the harness executes it item by item. `decide` is a per-task version of this (built).

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

### Scratchpad contract

Each node writes working notes in a grammar-enforced block (`<scratchpad>…</scratchpad>` beside `<output>`, or a `scratchpad` field in the JSON schema). The harness stores the scratchpad with the task and injects it into later nodes that depend on it, as memory scoped to the run. Today only dependency results are passed forward; a per-agent scratchpad folder is proposed under Agent hierarchy.

### Specialist models

Keep several 1–4B task-specific models on disk (extraction/classification, code, summarisation, a reasoning-tuned model such as Phi-4-mini-reasoning for logic nodes; ~2–2.5 GB each at 4-bit per the chat) and load the right one per task into the 4 GB GPU, unloading after. Built parts that help: `ModelCache` reload, optional separate background model, GPU lock. Missing: a router choosing the model, specialist selection, measured swap latency (the chat says "a fraction of a second to a few seconds"). Constraints: the router must be reliable; the specialist sees only pre-filtered context; a reasoning model's long thinking must be constrained or it costs latency. Compare against "Model escalation" above.

### Fact and rule engine (neuro-symbolic)

A deterministic rule layer beside the model; rationale in doc 1 ("Neuro-symbolic reasoning").
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

### Self-improving domains

Rationale in doc 1 ("Self-improving domains"). A domain pack becomes the unit the system gets better at, not only the unit it is configured by.

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
- User memory, entities (people, organisations, threads) and the world model are shared; a domain's scope holds only what is specific to it. This matches "Memory layers and domain rule sets" in doc 1: facts shared, rule modules per domain.

### Cognitive loop: goals, drives and initiative

The long-range aim (doc 0): perceive → update memory → evaluate goals → plan → act → review feedback, run continuously by the harness. Built parts: connectors and the event queue (perceive), recall and consolidation (memory), the scheduler's priority classes (prioritise), checks (review), idle research (curiosity). Proposed:
- **Goals and drives as harness state:** numeric levels (e.g. curiosity, urgency, upkeep) and a goal list stored in the database, visible and editable by the user, injected into prompts to modulate priority and tone, and readable by rules. The same mood value could drive the mascot and the voice.
- **Initiative:** the scheduler picks idle work from goals and drives instead of a fixed chain (see "Goal-driven idle jobs" in the roadmap).
- **Limits:** whether the model may propose or change goals is open; any change it makes should be gated (user approval or a rule) and every action stays within the autonomy ladder.
