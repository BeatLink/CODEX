# Architecture

How SmartHarness is put together: which process owns what, how one request flows through the model,
and how the knowledge store and the background worker grow memory between requests. The README
covers usage and settings; this document covers structure.

## The idea in one paragraph

A small local model does badly when asked to do a whole job in one call, and it cannot tell when it
does not know something. SmartHarness therefore never sends it the whole job. Each request is worked
as a tree of narrow tasks, each model call sees only the input it needs, replies that drive control
flow are forced into JSON by a grammar, and facts are taken from evidence the harness gathered
rather than from the model's memory. A SQLite knowledge store keeps that evidence between requests,
and a background worker uses idle time to turn it into facts, topic summaries and a topic hierarchy.

## Processes and threads

```
 TUI (Textual)   GTK 4 app   one-shot CLI
       \             |           /
        \            |          /          one JSON object per line
         +--- Unix socket: $XDG_RUNTIME_DIR/smartharness/daemon.sock ---+
                             |
                     smartharness-daemon
         +-------------------+---------------------+
         | socket server     | run thread          | background thread
         | (one thread per   | (one request at a   | (research and learning
         |  client)          |  time)              |  while no run is active)
         +-------------------+----------+----------+
                                        |
                             model lock + ModelCache
                                        |
                          llama-cpp-python, one GGUF model
                                        |
                         KnowledgeStore (SQLite, WAL mode)
```

- **The daemon** ([daemon.py](../smartharness/daemon.py)) owns the loaded model, the settings, the
  active run and the background worker. Interfaces hold no state of their own; they render the
  events the daemon broadcasts, so several can watch the same run.
- **Interfaces** ([tui.py](../smartharness/tui.py), [gtk_app.py](../smartharness/gtk_app.py),
  [cli.py](../smartharness/cli.py)) connect through [client.py](../smartharness/client.py) and start
  a daemon when none answers. A one-shot CLI run without a daemon runs the request in-process and
  never starts the background worker.
- **The protocol** ([protocol.py](../smartharness/protocol.py)) is newline-delimited JSON: requests
  `{"id", "method", "params"}`, replies `{"id", "result" | "error"}`, and unsolicited
  `{"event", "data"}` lines such as `run.token` and `run.tree`.
- **One model, one lock.** A run holds the model lock for its whole duration. The background worker
  takes the same lock for one model call at a time and checks before every step and every streamed
  token whether a run has started; if so it raises out, puts its job back in the queue, and releases
  the lock. A foreground request therefore waits for at most one token.
- **ModelCache** ([pipeline.py](../smartharness/pipeline.py)) keeps one `Llama` instance and reloads
  it only when the model path, context size or GPU layers change.
- **A separate background model** (`background_model_path`) has its own `ModelCache` and lock, so
  it never evicts the main model. It still gives way to a run in the same way, and the daemon
  unloads it after five minutes without background work.

## How a request runs

`runner` in the settings picks one of two engines. Both share the same building blocks (model
calls, context fitting, tools, evidence checks, knowledge access); they differ in who decides the
shape of the work.

| Runner | Module | Shape of the work |
| --- | --- | --- |
| `tree` (default) | [task_tree.py](../smartharness/task_tree.py) | The model decides, task by task, whether to answer, research, read files, act, or split |
| `pipeline` | [pipeline.py](../smartharness/pipeline.py) | A fixed chain of up to eight stages, with a mode router choosing which stages run |

### Task tree

The request becomes task `1`, whose deliverable is a complete reply. Subtasks are numbered by path
(`1.2.3`), so depth is the number of dots. `TaskTree` caps depth (`max_task_depth`) and size
(`max_task_nodes`); `TaskTreeRun` works the tree depth-first.

```
work(task)
 ├─ decide ──────────── JSON: reason, facts_to_check, approach, search_queries, subtasks
 │                      (schema lists only the approaches this task may take)
 ├─ approach = decompose
 │    ├─ work(subtask) for each, in order
 │    │    └─ a failed subtask → re-plan the rest once
 │    ├─ combine ────── text, from the subtask results
 │    └─ check → revise once → check
 └─ approach = answer | research | files | act
      ├─ gather ─────── stored knowledge / web search, then the tool loop for that approach
      ├─ write ──────── text
      ├─ check → revise once → check
      └─ still failing → split into smaller subtasks and work those instead
```

Rules that keep a small model on track:

- **Constrained choices.** The decision schema's `approach` enum contains only what settings and
  limits allow: `act` only when writes, tests or an MCP server are enabled and the mode may change
  things; `decompose` only while there is room for two more subtasks. llama.cpp enforces the schema
  as a grammar.
- **Research is forced, not optional.** Any non-empty `facts_to_check` turns `answer` into
  `research`. The top task always searches the request's own words, and a top-level `answer` still
  gets one quick search unless the request is arithmetic or rewriting pasted text.
- **No runaway splitting.** A subtask whose content words match its parent or any other task is
  dropped; fewer than two real subtasks means the task is done directly; dependencies may only
  point backwards; a task created by a split is never split again.
- **Failure stays local.** An error in a subtask marks it `failed`, and its parent re-plans the
  remaining subtasks once. Only an error in the top task fails the run.
- **Each call sees where it is.** Input sections, most important first: the original request, the
  current task and deliverable, today's date, any correction, the call's own material, the
  clarification, results of tasks it depends on, gathered evidence, the tree outline, and recalled
  memory. Trimming takes from the end, so memory is the first to go.

### Eight-stage pipeline

Identify → Research → Plan → Review plan → Act → Draft → Critique → Revise. Stage 1 starts with a
short router call that picks `answer`, `draft` or `execute`, and each mode runs only its own subset
of stages (a quick answer is two model calls). The plan is reviewed before any tool acts, execute
mode is checked against the recorded tool calls rather than by a model critique, and the
critique/revise loop runs at most two rounds. The README has the full stage table.

## Shared machinery

### Model calls

`run_stage` sends one system prompt and one user message, streams tokens to a callback, and passes
an optional JSON schema as llama.cpp's `response_format`. Replies that drive control flow
(decisions, checks, critiques, routes, background extraction) always use a schema; prose replies do
not. Every parser has a fallback for a malformed reply, so a bad reply degrades the run rather than
crashing it.

### Context budget

[context_budget.py](../smartharness/context_budget.py) counts tokens with the model's own
tokenizer. Each call's budget is the context size minus its reply budget, the system prompt and a
template reserve. Short JSON replies get smaller reply budgets (1024 for decisions, 512 for checks)
so their input has more room. When input overflows, the largest unpinned sections are first
condensed by a summarize call (each section at most once per run, cached), and only what still
overflows is trimmed. The original request and the current task are pinned.

### Tools

[tools.py](../smartharness/tools.py) holds the built-in tools: `web_search` (DDGS), `web_fetch`
(public addresses only, rechecked after redirects), `list_directory`, `read_file`, `write_file`
(only with `allow_file_writes`) and `run_tests` (only with `enable_test_execution`). File paths must
stay under `filesystem_root`, and sensitive file names are refused. [mcp_tools.py](../smartharness/mcp_tools.py)
adds tools from configured MCP servers, limited to each server's `allowed_tools`.

[tool_stage.py](../smartharness/tool_stage.py) runs the tool-calling loop for a stage or a task's
gather step, with an allow or block list per approach and at most `max_tool_calls` calls. Fetched
pages are summarized in chunks for a focus the model supplies, and the chunk summaries are merged.

### Checks that do not rely on the model

The model's own verdicts are backed by deterministic checks, applied to the task tree's check step
and to the pipeline's critique:

- A cited URL that appears in no captured evidence is a problem.
- After research, a version number or date that appears in no evidence and not in the request is a
  problem. Dates are compared by value, and numbers inside code blocks are ignored.
- In execute mode, the report must match the recorded file writes and test runs.
- When every search found nothing, the writer is told not to describe what it could not look up.

## Knowledge store

[knowledge.py](../smartharness/knowledge.py) is one SQLite file (`knowledge_db_path`) in WAL mode,
opened per operation. The schema is versioned with `PRAGMA user_version`; each migration commits
with its version bump, and a database newer than the code is refused.

| Table | Holds |
| --- | --- |
| `topics` | Name (unique, case-insensitive), `parent_id`, priority, summary, use count, last researched, last placed |
| `sources` | URL (unique), title, snippet, fetched-page summary, query, topic, retrieved and expiry times |
| `facts` | One statement under a topic, its source, a confidence from 0 to 1, a status (`active`, `disputed`, `pruned`), use count |
| `user_memory` | Preferences, projects and corrections about the user, `active` or `superseded` |
| `episodes` | Each finished request: prompt, mode, checklist or tree outline, answer, outcome, tree snapshot |
| `knowledge_search` | FTS5 index over sources (title, snippet plus summary, URL) |
| `embeddings` | One vector per fact and topic, with the model and text it was made from |
| `memory_search` | FTS5 index over facts and episodes |
| `graph_nodes`, `graph_edges` | Topic, source and entity nodes; `contains`, `supported_by` and extracted relations, each edge optionally tied to a source |
| `research_queue` | Jobs per topic: pending, running, done or failed, at most one pending per topic |
| `consolidation_checks` | The stored verdict for each topic, fact or memory pair already compared |

The knowledge is organised in three layers that mirror each other:

- **The topic tree** is `topics.parent_id`. The background worker files each researched topic under
  a broader parent the model names, and rewrites the parent's summary from its children's.
- **The fact store** is `facts` plus `sources`, with FTS5 indexes for lexical retrieval.
- **The relationship graph** is `graph_nodes` and `graph_edges`.

### Reading from it during a request

There are two read paths, used at different moments:

1. **Recall** (`KnowledgeStore.recall`), before the first model call. It returns the ten most-used
   user memories, plus facts and past episodes whose text shares half the prompt's search terms,
   or three of them for a longer prompt (stopwords removed, at most twelve terms), those sharing
   the most terms first. When fewer than five match, recall walks the topic tree: it takes the most
   specific topic whose whole name appears in the query and fills up from facts in that topic and
   its subtopics. With an embedding model ([embeddings.py](../smartharness/embeddings.py)), the
   query is also embedded and compared with every fact's vector through sqlite-vec; facts above a
   similarity floor are merged with the word matches by reciprocal rank fusion, and when no topic
   is named, the topic closest in meaning supplies the branch. Each recalled fact carries its chain of ancestor topics and their
   summaries, and the recalled facts bring up to five graph relationships of the entities they
   name. The result is formatted as a "Remembered context" section, and recall bumps the use
   counts of what it returned. In a task tree, each subtask adds the facts its own prompt recalls,
   and each search query recalls facts as a "Stored facts" evidence section; when facts or stored
   summaries answer every query of a task, its tool loop is skipped. A fact whose source has
   expired (or, with no source, that is older than the source lifetime) is shown as possibly out
   of date, cannot answer a query on its own, and queues its topic for research.
2. **Search with memory**, for every search query (`search_with_memory`). It looks the query up in
   `knowledge_search`, keeping unexpired sources that share half the query's terms. A hit is used
   as "Local knowledge result" and no web search runs; when every query was answered by a stored
   page or topic summary, the task's tool loop is skipped as well. A miss runs `web_search`, and a
   search that finds nothing queues the query as a research topic.

### Writing to it during a request

- Every web search's results are stored as sources under a topic named after the query, and that
  topic is queued for background research unless it already has facts.
- Every page summary that `web_fetch` produces is saved on its source.
- Every sentence a check rejects for stating a version or date found in no evidence is queued as a
  research topic, up to three per check.
- The finished request is saved as an episode, with the task tree snapshot for tree runs.

## Background worker

`HarnessDaemon._background_loop` runs on its own thread for the life of the daemon:

```
loop:
  paused and no manual request   → wait poll interval
  a run is active                → wait 1 s
  otherwise:
    re-queue topics researched longer ago than background_refresh_interval_hours
      (half that for topics recalled five times and used since; most used first)
    research_one_topic()       — if a job was pending
    or index_knowledge()       — if facts or topics lack a vector (CPU embedding model)
    or learn_from_episodes()   — if unprocessed episodes exist
    or consolidate_knowledge() — if anything is left to tidy
    worked → wait 0.2 s, else wait poll interval
```

`research_one_topic` ([background.py](../smartharness/background.py)) claims the highest-priority
pending job and:

1. Runs `web_search` on the topic name, then fetches and summarizes the first two result pages.
2. Numbers every page summary and search snippet as a source, then extracts up to five facts from
   each page on its own and from the snippets together, each with a source number and a
   `low`/`medium`/`high` confidence (stored as 0.3, 0.6, 0.9). Small groups keep each reply short,
   and one group failing loses only its own facts. Each fact is then held to the sources: one
   stating a version or date that no source contains is dropped, and one whose values or half of
   whose words are missing from the source it cites, or that cites none, drops to low confidence.
3. Makes one overview call for the topic summary, up to five entity relationships, and a parent
   topic, offering the existing top-level topics so the model can reuse one.
4. Stores the sources, page summaries, facts and relationships, files the topic under its parent,
   and rewrites the parent's summary from its children's.

A paused job goes back to `pending`; any other error marks it `failed` with the message.

`learn_from_episodes` reads up to five unprocessed episodes and asks for durable preferences,
projects and corrections, with an instruction to leave out secrets and personal identifiers. The
same reply names up to three general subjects worth researching for the user's ongoing work, and
each that has no facts yet is queued. The episodes are marked processed even when the call fails, so one bad batch cannot block the worker.

### Consolidation

`consolidate_knowledge` ([consolidation.py](../smartharness/consolidation.py)) does one small piece
of tidying per pass, so it yields to a run as quickly as research does.

1. **Without the model** (`KnowledgeStore.tidy`): break topic parent loops, merge topics whose names
   have the same words and facts that differ only in case and punctuation, remove empty topics,
   and mark low-confidence facts that were never recalled as `pruned` once they are
   `background_prune_after_days` old.
2. **With the model**, one call per pass, in this order: rename a topic still called by the search
   query that found it to a short subject name (folding it into the topic that already has that
   name), compare two topics (same subject, one
   broader, or different), re-place one topic under the narrowest of up to 20 related topics or the
   top level, compare two facts under one topic (same, contradict, different), and compare two user
   memories. Candidate pairs must share at least half their words. Every reply is a short reason
   and a verdict from a schema enum, and each verdict is stored in `consolidation_checks` so a pair
   is asked about only once.

Merges keep the more trusted item and carry over its facts, sources, subtopics, queued research and
graph edges. Contradicting facts are marked `disputed` and their topic is queued for fresh research;
a contradicted user memory has its older side `superseded`. Disputed, pruned and superseded items
are no longer recalled.

## Request data flow

```
prompt ─► recall (user memory, facts + topic path, episodes) ─► "Remembered context"
   │
   ▼
decide ─► search_with_memory(query)
              ├─ stored hit ─► Local knowledge result
              └─ miss ─► web_search ─► sources + topic ─► research_queue
                                                │
gather (tool loop) ─► web_fetch ─► page summary ┘ saved on the source
   │
write ─► check (model verdict + URL and value checks) ─► revise / split
   │
answer ─► episode ─────────────────────────────────────► learn_from_episodes
                                                          (idle time)
research_queue ─► research_one_topic (idle time) ─► facts, summaries, parent topic, graph
                                                          │
                     consolidate_knowledge (idle time) ◄──┘ merge, re-file, dispute, prune
```

## Current weak points

These are properties of the code as it stands, recorded so changes can be measured against them.

- **Source search is lexical.** Recall finds facts and topics by meaning, but the stored-sources
  lookup before a web search still needs shared words.
- **Vector search is brute force.** Every recall compares the query with every stored vector; fine
  for thousands of facts, slow for millions.
- **The pipeline recalls once, on the whole prompt.** Only the task tree recalls for each subtask
  and search query.
- **Branch routing picks one branch.** Recall enters only the most specific named topic, or the
  single closest one in meaning, even when the question spans several.
- **The graph is read one step out.** Recall adds the relationships of entities a recalled fact
  names, but never follows them further or uses them to find facts.
- **Stale facts are flagged, not retired.** A fact whose source expired is recalled with a warning
  and its topic is re-researched, but it stays `active` until a newer fact contradicts it.
- **Fact grounding is lexical.** A fact is checked against its source by shared words, versions
  and dates, so a paraphrase that changes a claim's meaning but keeps its words still passes.
- **Duplicates must share words.** Consolidation renames query-named topics and merges and re-files
  topics, but only pairs that share half their words are ever compared, so differently worded
  duplicates stay apart.
- **Use counts only grow.** A topic recalled often long ago still counts as often used, so its
  refreshes stay frequent as long as it is used at all.
