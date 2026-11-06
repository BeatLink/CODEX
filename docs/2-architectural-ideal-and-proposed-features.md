# Architectural ideal and proposed features

<<<<<<< HEAD
Source: `research/architecture.md` (describes the system as built) and `research/agent-hierarchy.md`. Paths are under `src/`. Statuses are from research files, not yet verified against code.
=======
Source: `research/done-architecture.md` (describes the system as built) and `research/done-agent-hierarchy.md`. Paths are under `src/`. Statuses are from research files, not yet verified against code.
>>>>>>> d4db434 (Docs restructuring)

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
| `memories` | stores: general, user, locations, software, project, research, code; learned/probed/user-stated; `active`/`superseded` |
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

<<<<<<< HEAD
- **Events:** `MailConnector` (`core/mail.ts`, Maildir folders in `mail_maildir_paths`) and `ImapConnector` (`core/imap.ts`, `mail_imap_accounts`) queue events. `handleNextEvent` (`core/events.ts`) claims the most important event and runs its type's handler: `notify` → proposed action; `email.received` → triage (`core/triage.ts`); no handler → `ignored`. `email.draft` and `user.request` are worked as task trees (`core/eventTree.ts`): holds the model lock, stops when foreground work arrives (event requeued), result becomes a `draft`/`result` action. A tree from an `external`-trust event runs with `trust: 'external'`: no `act`, file writes, test runs or MCP tools; research may search but not fetch pages or read files. Interfaces use `post_event`, `events`, `actions`, `resolve_action`. Design: `research/reactive-assistant.md` (not yet processed).
=======
- **Events:** `MailConnector` (`core/mail.ts`, Maildir folders in `mail_maildir_paths`) and `ImapConnector` (`core/imap.ts`, `mail_imap_accounts`) queue events. `handleNextEvent` (`core/events.ts`) claims the most important event and runs its type's handler: `notify` → proposed action; `email.received` → triage (`core/triage.ts`); no handler → `ignored`. `email.draft` and `user.request` are worked as task trees (`core/eventTree.ts`): holds the model lock, stops when foreground work arrives (event requeued), result becomes a `draft`/`result` action. A tree from an `external`-trust event runs with `trust: 'external'`: no `act`, file writes, test runs or MCP tools; research may search but not fetch pages or read files. Interfaces use `post_event`, `events`, `actions`, `resolve_action`. Detail: "Reactive assistant" section below.
>>>>>>> d4db434 (Docs restructuring)
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

Built (prototype; verify against code in the later codebase review):
- `src/core/agents.ts`: loads agent files, resolves delegation targets.
- `delegate` in the task tree with nested run, per-agent MCP servers and instructions.
- Interfaces show only `delegate` plus the agent name, not the nested tree.

<<<<<<< HEAD
=======
Agents eval assets (on an unmerged branch at the time of the report; verify):
- `evals/fake_mcp_server.mjs` + `evals/fake_catalogue.json`: six canned MCP servers (mail, calendar, notes, contacts, weather, todos), 32 tools, no real accounts needed.
- `evals/agents/`: seven agent files; `comms` has `mail` and `contacts` as sub-agents (tests nesting).
- `evals/agents_tasks.json`: eight tasks: six need one specialist, one needs two hops (find a contact, then search their mail), one needs two unrelated specialists. Per-task `servers` field.
- An `agents` runner beside the flat `tree` runner; they differ only in whether agent files are present.

>>>>>>> d4db434 (Docs restructuring)
Proposed, not built:
- **Per-agent persistence:** a memory scope per agent in the knowledge store, filled by learning from that agent's episodes, plus a scratchpad folder under the state directory.
- **Resume inside an agent:** checkpoints save the delegating task, not the nested run, so a resume restarts the delegation.
- **Show the nested tree** in the interfaces.
- **Per-agent skills and tool allow lists** beyond MCP servers.
<<<<<<< HEAD
=======

## Reactive assistant

Source: `research/done-reactive-assistant.md`. The built plumbing (queue, scheduler, handler registry) is already summarised under "Background worker" above; this adds detail.

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
- **Entities and commitments**, then idle jobs driven by them: pre-research for tomorrow's meetings, stale-commitment sweeps, entity profiles from episodes, daily digest.
- Other connectors: calendar, file watchers, timers, webhooks.
- Mailbox coalescing / backlog policy; rolling thread summaries; idle-work budget.

## Model escalation (proposed)

Default to the 4B model in a fixed harness-owned pipeline. Proposed: escalate planning and steps that fail repeatedly to Qwen3.5-35B-A3B (~3B active parameters). Not built. See rationale doc, "Is a 4B model enough?".

## Voting and red-flagging (proposed, from MAKER)

Sample a step several times and decide by first-to-ahead-by-K voting; discard confused answers (too long, badly formatted) before they vote and resample. Candidate for control-flow calls (decisions, checks) where replies are schema-constrained and cheap. Not built. Evidence is from one perfectly verifiable domain; test on Codex's own evals before adopting.

## Mascot emotions (built)

Source: `research/done-mascot-emotions.md`. The robot from the CODEX icon sits at the foot of the workbench sidebar, beside the run status, and shows an emotion. The work is split:

- **CODEX** draws the rounded hexagon and the head: dark screen, ears, antenna and antenna light, floating z's. The head's movements are CSS keyed by `data-state` on the `svg`: a slow bob in every mood, a head tilt for `curious`, the antenna light pulsing for `thinking`, and a dim antenna, slower bob and z's for `asleep`. Files: `src/renderer/mascot.css` and the markup in `src/renderer/index.html`.
- **RoboEyes** (github.com/x-tech-laboratories/RoboEyes, an npm git dependency pinned to a commit) draws only the eyes and mouth, on a canvas laid over the head's screen through a `foreignObject`, so the face moves with the head. The canvas is 112 by 80 pixels, shrunk into the head's 28 by 20 units so it stays sharp. `src/renderer/mascot.ts` holds the face's settings and the 11 moods as RoboEyes face states. RoboEyes moods with the same names are replaced, not merged into.

**11 emotions:** `calm` (smirk, slow blink), `thinking` (glancing up from side to side, flat mouth), `curious` (slightly wide, looking up), `happy` (happy eyelids, soft smile), `sad` (tilted eyelids, faint frown, looking down), `asleep` (closed eyes, short mouth), `worried` (tilted eyelids, wry mouth, darting), `excited` (wide, bouncing), `focused` (narrowed, scanning), `startled` (eyes pop wider once), `waking` (eyes flutter open).

**Lasting moods**, most urgent first (`lastingMood`):

| Emotion | State |
| --- | --- |
| `worried` | `connection: 'unavailable'` |
| `waking` | `connection: 'connecting'` (launch) |
| `asleep` | `suspended` |
| `startled` | `cancelling` |
| `curious` | `clarifications` not empty |
| `thinking` | `running` |
| `focused` | background research working (`backgroundState` is `working`) |
| `calm` | otherwise |

**Moments** show for a few seconds over the lasting mood, then it comes back: `excited` (2 s) when a run starts, `happy` (3 s) when a run ends `Complete`, `waking` (2 s) when the daemon resumes, and `sad` (3 s) on any error notice. Nothing interrupts `worried`.

**Loading:** the renderer has no bundler, so an import map in `index.html` points `@x-tech-laboratories/roboeyes` at `node_modules` beside `dist`; the content security policy allows the map by its hash. RoboEyes follows `prefers-reduced-motion` itself, and `mascot.css` stops the head's movement under the same setting. The tray icon stays a still image.

## Speech output (proposed)

Source: `research/done-research-open-source-tts.md`. Give the mascot a voice: a TTS engine feeds RoboEyes' `speakVisemes` with real phonemes and durations, and a mood value drives eyes, mouth and voice together. Engine choice and trade-offs are in the rationale doc ("Text-to-speech"). Chatterbox would be an optional backend behind a small local server on a machine with enough VRAM; the dev laptop's 4 GB GPU is shared with the main model (see GPU lock), so voice must not compete for it. Not built.

## Ideas from the founding conversation (all proposed unless noted)

Source: `research/done-core-structure-ideas.md`. Rationale and caveats are in doc 1 ("Founding ideas"). Nothing below is known to be built; check each in the codebase review.

### Verified self-authored skills

A skill is a markdown guide the harness injects into a fresh context when a request matches it (matching exists, by approach).
1. **Attempt:** the task runs normally.
2. **Judge:** the harness decides whether the run was messy or failed, from deterministic signals (tool errors, failed checks, user correction), not from the model's opinion.
3. **Reflect:** the trace is fed back with a prompt asking for a reusable checklist for that kind of request.
4. **Gate:** the draft is saved only if a non-LLM check passes: a generated test run against a sandbox or mock state (`run_tests`), a schema validator, or a deterministic baseline. Generate several, keep those that pass; discard the rest.
5. **Store and retrieve:** save under a skills folder; retrieve by keyword or embedding match against the request.
- Error-driven variant: when schema validation fails on extraction (e.g. a missing `deadline`), ask the model to rewrite its instruction and save the patch, again behind the gate.
- Why the gate: unverified self-generated text drifts ("copy of a copy"), and a wrong skill is injected into every later matching call.

### Blueprints for recurring requests

Hard-coded task graphs for requests that always have the same shape (e.g. "process my morning inbox": fetch unread, loop in code, one item plus strict schema per model call, deterministic summary). Mail triage and drafting already work this way. Open question: which other recurring requests justify one, versus letting `decide` split them.

### Specialist models (alternative to one big model)

Keep several 1–4B task-specific models on disk (extraction/classification, code, summarisation; ~2–2.5 GB each at 4-bit per the chat) and load the right one per task into the 4 GB GPU, unloading after. Built parts that help: `ModelCache` reload, optional separate background model, GPU lock. Missing: a router choosing the model, specialist selection, measured swap latency (unmeasured; the chat says "a fraction of a second to a few seconds"). Constraints: the router must be reliable; the specialist sees only pre-filtered context. Compare against the escalation proposal below.

### Procedural memory and retry feedback

- Log each tool/format failure mode to a lessons file and inject it into later system prompts (partly covered by learned corrections; a failure-mode log specifically is unconfirmed).
- On invalid output, feed the validation error back for one cheap correction turn (current design: grammar-forced JSON, fallbacks, one revise pass).

### Drives and mood (open, not adopted)

The chat suggests numeric state variables in the prompt (e.g. curiosity, task urgency) to modulate tone and priority, and a continuous perceive → update memory → evaluate goals → plan → act → review loop. Closest existing pieces: the scheduler's priority classes, the idle worker, and the mascot's mood (see "Mascot emotions"). Any drive or self-set goal must stay inside the autonomy ladder; the user, not the model, sets goals.
>>>>>>> d4db434 (Docs restructuring)
