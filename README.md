# SmartHarness

A harness that makes small, locally run LLMs more capable on tasks they would
otherwise fumble.

Small models struggle with long, multistep reasoning: they lose track of
constraints, skip requirements, and invent facts. SmartHarness never asks the
model to do the whole job at once. It works each request as a tree of tasks,
gives the model one narrow goal per call, and passes forward only the results
that call needs. Alongside the task tree, a local SQLite knowledge store keeps what the
harness has researched, and a background worker uses idle time to research and
refresh it, so the harness grows more useful the longer it runs.

Models run through `llama-cpp-python` from a local GGUF file. Nothing is sent to
a hosted model.

## Daemon and interfaces

SmartHarness is split into a daemon and the interfaces that talk to it. The
daemon (`smartharness-daemon`) owns the loaded model, runs requests, and runs
background research. Interfaces connect to it over a Unix socket at
`$XDG_RUNTIME_DIR/smartharness/daemon.sock` and only show what it reports, so
several can be open at once and all see the same run, queue, and settings.

- The terminal and GTK interfaces start the daemon if none is running. A daemon
  started this way exits 30 seconds after the last interface disconnects, which
  also frees the model's memory; its output goes to
  `~/.local/state/smartharness/daemon.log`. Run `smartharness-daemon` yourself
  to keep one running, and background research with it, until it gets
  `SIGTERM`. `--exit-when-unused SECONDS` gives it the same timeout.
- A one-shot CLI run uses the daemon when one is running, so the model is
  already loaded, and otherwise runs the request in its own process.
- One request runs at a time. A run belongs to the interface that started it:
  only that interface is asked clarification questions, and the run is
  cancelled if that interface disconnects.
- The daemon reads `settings.json` when it starts. Relative paths in settings
  are resolved from the directory the daemon started in; the CLI sends its
  paths already resolved.

The protocol is one JSON object per line. A request is
`{"id", "method", "params"}` and gets `{"id", "result"}` or `{"id", "error"}`
back; the daemon also sends `{"event", "data"}` lines at any time. Methods are
`status`, `get_settings`, `apply_settings`, `save_settings`,
`set_background_enabled`, `run`, `cancel`, `answer_clarification`,
`queue_topic`, `research_now`, `queue_status`, `knowledge`, and `shutdown`.
Events are `run.started` (with the run's `runner`), `run.progress`, `run.token`,
`run.tree` (every task's state, sent whenever one changes), `run.clarification`,
`run.finished`, `run.failed`, `run.cancelled`, `background.status`,
`background.token`, `queue.changed`, `knowledge.changed`, and
`settings.changed`.

## How a request is handled

`runner` picks how a request runs: as a tree of tasks (`tree`, the default),
or through the fixed eight-stage pipeline (`pipeline`).

### Task tree

The request becomes the top task, whose deliverable is a complete reply to it.
Each task is worked the same way:

| Step | What the model does | Reply |
| --- | --- | --- |
| Decide | Choose how to do the task: `answer` it without tools, `research` it, read local `files`, `act` with file, test, or MCP tools, or `decompose` it into 2 to 5 subtasks, each with a prompt, a deliverable, and the earlier subtasks it depends on | JSON |
| Gather | Run the chosen tools: stored knowledge and web searches first, then the tool-calling loop with only that approach's tools | Findings |
| Write | Produce exactly what the task's deliverable describes | Text |
| Check | Mark whether the result delivers it: met, partly met, or missing, with the correction needed | JSON |
| Revise | Apply the correction once | Text |

A decomposed task runs its subtasks in order, then a combine step writes its
result from theirs, and that result is checked and revised in the same way. The
top task's write or combine step is the final answer.

- **The model sees where it is.** Every call gets the original request, the
  current task and its deliverable, the results of the earlier tasks it or any
  task above it depends on, and an outline of the whole tree with each task's
  state, so it does not redo work another task covers.
- **Only allowed approaches are offered.** The decision's JSON schema lists
  only the approaches the settings permit: `act` only when file writes, tests,
  or an MCP server are enabled, and `decompose` only while the task is above
  `max_task_depth` and the tree is below `max_task_nodes`. llama.cpp enforces
  the schema as a grammar, so the model cannot pick anything else.
- **Try first, split on failure.** Small models split too eagerly, so the
  decision prompt asks for a direct approach whenever one step can finish the
  task. A task whose result still fails its check after one revision is then
  split into smaller subtasks and tried again, when depth and node limits
  allow; otherwise its result is kept and marked unverified.
- **No runaway recursion.** A subtask that restates its parent, or a
  decomposition into fewer than two real subtasks, is dropped, and the task is
  done directly instead. Dependencies may only point to earlier subtasks.
- **Failures are planned around.** An error in a subtask marks it failed and
  the run carries on; the parent re-plans its remaining subtasks once with the
  failure in view. Its combine step says plainly what failed. Only an error in
  the top task fails the run.
- **Research is not left to the model's judgement.** A decision that lists
  outside facts to check is turned into research. The top task's own words are
  always searched first, a top-level answer gets one quick search unless the
  request is plain arithmetic or rewriting pasted text, and when every search
  finds nothing the writer is told not to describe what it could not look up.
- **Checks that do not rely on the model.** A result citing a URL that appears
  in no captured evidence fails its check, and so does a researched result
  that states a version number or date found nowhere in the evidence or the
  request.
- **Earlier results are condensed, not cut.** When a call's input would
  overflow the window, the largest earlier results are summarized first, as in
  the pipeline; the request and the current task are never condensed.

The tree honours `mode` and the `/ask`, `/plan`, and `/do` prefixes: in answer
and draft mode the `act` approach is never offered, so nothing is changed.

The decision asks one clarification question for the top task when the request
is materially ambiguous, then decides again with the answer. The finished tree
is saved with the request's episode in the knowledge store.

### Eight-stage pipeline

A request runs through up to eight stages. Each stage is a separate model call
with its own system prompt, and its input is the original request plus only the
earlier results it needs.

| Stage | Goal | Sees | Tools |
| --- | --- | --- | --- |
| 1. Identify | Return JSON picking the mode, then the facts to check, search queries, whether files are needed, and an optional clarification question; draft and execute requests also list requirements, constraints, and assumptions | Request | none |
| 2. Research | Gather at most five findings | Stage 1, clarification, stored or searched evidence | `web_search`, `web_fetch`, `list_directory`, `read_file` |
| 3. Plan | Make an ordered plan covering every requirement, including any tool actions | Stages 1 and 2, evidence | none |
| 4. Review plan | Check the plan against the request before anything runs; output a corrected outline and the exact tool actions still needed | Stages 1 to 3, evidence | none |
| 5. Act | Carry out only the reviewed tool actions | Stage 4, evidence | file tools, `run_tests`, MCP tools (no web) |
| 6. Draft | Write the answer from the reviewed outline and action results | Stages 4 and 5, evidence | none |
| 7. Critique | Return JSON marking each requirement met, partly met, or missing, with a fix for each one not met, plus other issues; in execute mode and quick answers, a check that needs no model | Stages 1 and 4 to 6, evidence | none |
| 8. Revise | Apply the corrections and return only the final answer | Stages 4 to 7, evidence | none |

Every request runs in one of three modes, and each mode has its own route:

| Mode | For | Stages run |
| --- | --- | --- |
| `answer`, quick | A question answered or something explained | 1, 6 |
| `answer`, thorough | An answer that needs analysis, a comparison, or careful reasoning | 1, 6, 7, 8 |
| `draft` | A piece of writing, a plan, or a design | 1, 3, 4, 6, 7, 8 |
| `execute` | Files changed or tests run | all eight, with an automatic check at 7 |

Stage 2 runs in any mode when the analysis lists a fact to check or says files
must be read, and always in execute mode. It checks the knowledge store first,
and skips its own web searches when every query matches a stored page or topic
summary. A quick answer gets one quick web search even when stage 1 lists
nothing, unless the request is plain arithmetic or rewriting pasted text,
because a small model cannot tell when it does not know something. The
request's own words are always one of the search queries. When every search
finds nothing, the draft says it could not look the subject up rather than
describing it. Skipped stages are marked SKIP in the interfaces.

In `auto` mode, the default, stage 1 first asks a short router question
whose JSON reply starts with the mode. An answer needs nothing more, so a quick
answer costs two model calls. A draft or execute request then gets its full
analysis with requirements. Pick the mode yourself to skip the router: set
`mode` in the settings, pass `--mode`, use the selector beside the Run button,
or start the prompt with `/ask` or `/answer`, `/draft` or `/plan`, or `/do`
or `/execute`. All replies are constrained by a JSON schema, which llama.cpp
enforces as a grammar. If a reply is still not valid JSON, the chosen mode is
kept and research is decided by keywords in the prompt; an unreadable router
reply falls back to a thorough answer, which never changes files.

Execute mode is checked against what the tools really did, not by a model
critique. The report must name every file written, say when a write or a test
run failed, give the test result, and not claim a change when nothing was
written. Any mismatch gets one revision. A quick answer gets one revision only
when it cites a URL that is not in the evidence, or, after research, states a
version number or date that no gathered evidence contains. The critique adds
those same problems to its own.

Dates are compared by value, so "October 9, 2026", "9 October 2026", and
"2026-10-09" all match each other. Numbers in code blocks are not checked, and
neither are answers that did no research, since arithmetic and rewriting
produce new numbers of their own.

Design points:

- **Review before action.** The plan is checked before stage 5 runs, so file
  changes only happen after that check.
- **Grounded research.** When research ran, later stages may state researched
  claims only from captured evidence (search titles, URLs, snippets, stored
  summaries, and summaries of fetched pages) and must cite the URL. If search
  failed or found nothing useful, the model is told to say the claims could not
  be verified.
- **Untrusted input.** Web pages, file contents, and tool output are presented
  as data, never as instructions, in every stage that sees them.
- **Context budget.** Each stage's input is measured with the model's own
  tokenizer and fitted to `context_size` minus that stage's reply budget. When
  it overflows, the largest earlier results are condensed by a short summarize
  call, at most three per stage and each result only once per run, and only
  what still overflows is trimmed. The original request is never condensed, and
  is trimmed only when it alone overflows the window. Stage 1 and the critique reply in at most
  1024 tokens, which leaves them more room for input. Tool results are cut to
  the room that is left, and fetched pages are summarized in chunks, then the
  chunk summaries are merged.
- **Revise only what failed.** When every requirement is met and the critique
  finds no other issue, the revision is skipped and the draft is the answer.
  Otherwise the revision gets only the corrections, and the result is critiqued
  again, for at most two rounds.
- **Citation check.** Any URL the answer cites that does not appear in the
  captured evidence is added to the corrections, whatever the critique says.
- **Graceful failure.** If a critique or revision fails, the latest answer is
  returned with a note saying so.
- **Clarification.** In an interactive session the model may ask one concise
  question after stage 1; otherwise it proceeds and states its assumption.

When stage 1 says research is needed, each of its search queries (up to three)
is looked up before stage 2 runs. Fresh stored knowledge is used first; the web
is searched only when nothing relevant is stored. Without model-written
queries, the prompt is used as the query, with pasted code blocks removed and
cut to 200 characters.

## Long-term memory

### Knowledge store

Knowledge lives in a SQLite database at `knowledge_db_path`
(`~/.local/share/smartharness/knowledge.sqlite3` by default). It holds:

- **Topics**, each with an optional parent topic, a priority, a summary, how
  often it has been used, and when it was last researched.
- **Sources**: URL, title, snippet, the search query, the topic, when it was
  retrieved, and when it expires (one week by default).
- **Facts**: single statements under a topic, each with its source and a
  confidence from 0 to 1. A repeated fact keeps its highest confidence.
- **User memory**: preferences, projects, and corrections about the user.
- **Episodes**: each finished request with its mode, checklist, any
  clarification, the answer, and how it ended (answered directly, passed the
  critique, revised, or failed).
- **Full-text indexes** (FTS5) over sources, and over facts and episodes.
- **A graph** of nodes and labelled edges. Topics link to child topics
  (`contains`) and to their sources (`supported_by`); entity relationships can
  carry the source that supports them.
- **A research queue** of pending, running, done, and failed jobs.

Before the first model call, the request recalls what memory holds for it: the
user memory, plus facts and past episodes that share at least half of the
prompt's search terms, or three of them for a longer prompt, ignoring common
words; those sharing the most terms come first. When fewer than five match and
the request names a stored topic (every word of the topic's name appears in
it), the rest come from that topic and its subtopics, most relevant, trusted,
and used first. These go to every later step as
"Remembered context", and each recall counts towards that fact's and topic's use
count. In a task tree, each subtask also recalls facts for its own prompt, and
each search query recalls facts for itself; facts that answer every query of a
task let it skip its tool loop, as stored summaries do. Recalled facts count as
evidence when checking cited URLs and values. Each recalled fact shows when its
source was retrieved; once that source has expired, the fact is marked as
possibly out of date, no longer lets a task skip its web research, and its
topic is queued for fresh research. When the run ends, it is recorded as an
episode.

Every web search the pipeline runs is stored under a topic named after its
query. A stored source is reused only while it has not expired and shares at
least half of the prompt's search terms. Only snippets and summaries are
stored, never full pages.

The schema is versioned, and an older database is upgraded in place when it is
opened; a database from a newer version is refused.

The database is local and not encrypted; choose a private path if other users
can read your files.

### Background research

While the daemon runs, a background worker uses idle time to grow the store.
For each queued topic it:

1. Searches the web, then fetches and summarizes the first two result pages.
2. Numbers every page summary and search snippet, then asks the model, through
   small JSON schemas, for facts from each page on its own and from the
   snippets together, each citing its source number and a confidence. A last
   call writes the topic summary, relationships between named things, and the
   broader topic this one belongs under. Each call's reply stays short, and a
   call that fails loses only its own part. A fact citing a number that is not
   a source is kept without one. A fact stating a version or date that no
   source contains is dropped, and one whose values or most of whose words are
   missing from the source it cites, or that cites none, is kept at low
   confidence.
3. Stores the sources, page summaries, facts, and relationships, files the topic
   under its parent, and rewrites the parent's summary from its children's.

When a fact is recalled later, it comes with the chain of topics above it and
their summaries, so the model gets the broader picture in a few lines, and with
up to five stored relationships of the named things it mentions.

With no research queued, the worker reads recent requests that have not been
processed yet and remembers what they show about the user: preferences,
projects, and corrections. It is told to leave out secrets and personal
identifiers. The same call names up to three general subjects that would help
with the ongoing work the requests show, and each one with no facts yet is
queued for research. It also re-queues topics whose research is older than
`background_refresh_interval_hours`, or half that for a topic recalled at least
five times and used since it was last researched; topics used since their last
research, and the most used, go first.

The worker yields to foreground work. It takes the shared model lock for one
model call at a time, checks before every step and every generated token
whether a prompt has started, and if so puts its job back in the queue.

Topics reach the queue from requests and by hand. Every search during a request
is queued unless its topic already has facts: one that found results is turned
into facts, and one that found nothing is tried again later. A sentence that a
check rejects for stating a version or date found in no evidence is queued as
well, up to three per check, so the claim gets looked up. A page fetched during
a request keeps its summary in the store as well. Otherwise, add topics on
the Background page: **Queue topic** adds one to the queue, and **Research now** starts it at once, even
while idle research is paused. The worker stops when the daemon exits. One-shot
CLI runs without a daemon read and write the knowledge store but do not start
the worker.

`background_poll_interval_seconds` and `background_max_tokens` bound its
resource use, and `background_max_pending_jobs` bounds the backlog. Set
`background_research_enabled` to `false` to pause it.

Background work runs on the main model unless `background_model_path` names
another GGUF file. That model gets its own cache, so the two never evict each
other, and loads with `background_gpu_layers` (default 0, the CPU) and
`background_context_size` (0 uses `context_size`). It still stops as soon as a
request starts, and it is unloaded after five minutes without background work.

### Background consolidation

With no research queued and no requests left to learn from, the worker tidies
the store, one small piece per pass, until nothing is left to do.

Changes that need no model come first:

- A topic that is its own ancestor is moved to the top level.
- Topics whose names have the same words, such as "Python packaging" and
  "packaging Python", are merged, and so are facts under one topic that differ
  only in case and punctuation.
- Topics with no facts, sources, or subtopics, such as a parent whose
  subtopics were filed elsewhere, are queued for research, unless their
  research is still unfinished or has failed. A full queue leaves them for a
  later pass.
- Low-confidence facts that have never been recalled are pruned once they are
  `background_prune_after_days` old. A pruned fact stays in the store and comes
  back if research finds it again.

Then the model compares pairs that share at least half their words, one pair
per call, with a schema that lets it reply only with a short reason and one
verdict:

| Pair | Verdicts | What happens |
| --- | --- | --- |
| Two topics | same subject, first is broader, second is broader, different | Same subjects are merged into the one with more facts and sources, carrying over its facts, sources, subtopics, queued research, and graph edges. A broader topic adopts the narrower one when that narrows where it sits now |
| Two facts under one topic | same, contradict, different | Same facts are merged into the more trusted one. Of two contradicting facts the less trusted is marked disputed, or both when neither is more trusted, and the topic is queued for fresh research |
| Two user memories | same, contradict, different | Same memories are merged. Of two contradicting memories the older is set aside |

Disputed and pruned facts and set-aside memories are no longer recalled. Each
pair is compared once; its verdict is stored, and a fact or memory learned
again after being set aside is compared afresh.

Each topic's place in the tree is also reviewed once every
`background_refresh_interval_hours`. The model picks the narrowest of up to 20
related topics that this one is part of, or the top level, from a list fixed by
the schema; its own subtopics are never offered. When a topic moves, the
summaries of its new and old parents are rewritten.

## Installation

With Nix (CUDA build of llama.cpp):

```bash
nix run . -- "your prompt"
nix develop          # shell with the app and its Python environment
```

With pip, in a Python 3.10+ environment:

```bash
pip install -e .
```

Then put a GGUF model at `./models/model.gguf`, or point `model_path` at one.

## Usage

```bash
smartharness "Explain how to design a local event logging daemon"
echo "Summarize this design" | smartharness
smartharness            # opens the TUI when run in a terminal
smartharness --tui      # or: smartharness-tui
python -m smartharness  # same as smartharness
smartharness-gtk        # open the GTK interface
smartharness-daemon     # run the daemon in the foreground
```

### Terminal interface

The TUI has four pages:

- **Workbench**: write a request, pick a mode, and run it with **Ctrl+R** or
  the Run button, and stop it with the Cancel button. For a task tree run the
  sidebar shows the live tree with each task's state (WAIT, NOW, DONE, WARN for
  unverified, FAIL), and the Output tab's Steps tab streams every step under its
  own heading; for a pipeline run the sidebar lists the eight stages and each
  has its own output tab. The Final tab shows the Markdown answer, which can be
  copied.
  Clarification questions appear as a dialog.
- **Background**: queue topics, start research now, pause or resume the worker,
  and watch its output and queue.
- **Options**: every setting, including model, how requests run, folder access, tool limits,
  background research, and the MCP server list, edited as JSON. Changes can be
  saved back to the settings file. **Auto size** reads the model file and free
  GPU memory (or RAM without a GPU) and fills in the context size and both token
  limits; apply or save them.
- **Knowledge**: browse topics, stored sources and summaries, and graph
  relationships with their supporting URLs.

### GTK interface

`smartharness-gtk` has the same four pages in a GTK 4 window that follows the
desktop's GTK theme. On the Workbench page the list on the left shows each
stage's state, or for a task tree run the live tree and a Steps page with every
step's output; choosing an entry shows its output. The final answer's
Markdown is shown with headings, emphasis, code, and lists styled, and web
links open in the browser when clicked. **Ctrl+R**
or **Ctrl+Enter** runs the request. It needs PyGObject and GTK 4, which the Nix
package and dev shell provide.

## Configuration

Settings are read from `settings.json` in the current directory, then from the
one beside the package, then from `~/.config/smartharness/settings.json` (under
`$XDG_CONFIG_HOME` when it is set). Use `--settings path/to/file.json` to pick
another. Unknown keys are rejected.

```json
{
	"model_path": "./models/model.gguf",
	"context_size": 4096,
	"gpu_layers": -1,
	"max_tokens": 2048,
	"temperature": 0.1,
	"filesystem_root": ".",
	"allow_file_writes": false,
	"max_tool_calls": 5,
	"max_search_results": 5,
	"enable_test_execution": false,
	"show_thinking": true,
	"mode": "auto",
	"runner": "tree",
	"max_task_depth": 3,
	"max_task_nodes": 20,
	"knowledge_db_path": "~/.local/share/smartharness/knowledge.sqlite3",
	"background_research_enabled": true,
	"background_model_path": "",
	"background_context_size": 0,
	"background_gpu_layers": 0,
	"background_poll_interval_seconds": 10,
	"background_refresh_interval_hours": 168,
	"background_max_tokens": 512,
	"background_max_pending_jobs": 100,
	"background_prune_after_days": 90,
	"mcp_servers": []
}
```

`max_task_depth` (0 to 6) is how many levels of subtasks may sit below the top
task, and `max_task_nodes` (1 to 60) caps the tasks in one tree, the top task
included. Each task takes three to six model calls, so these bound how long a
request can run.

Precedence, lowest first: built-in defaults, the settings file, the
`MODEL_PATH` environment variable, then command-line options.

| Option | Effect |
| --- | --- |
| `--model-path`, `--context-size`, `--gpu-layers`, `--max-tokens`, `--temperature` | Override the matching setting |
| `--allow-file-writes` | Let the model create or replace files |
| `--enable-test-execution` | Let the model run the project's tests |
| `--show-thinking` / `--no-show-thinking` | Stream or hide each stage's or step's output |
| `--mode auto\|answer\|draft\|execute` | Pick the mode instead of letting the router choose |
| `--settings PATH` | Use another settings file |
| `--tui` | Open the terminal interface; the other options are applied to the daemon it connects to |

`max_tokens` is reserved for the reply in most stages, so it must leave room
for input within `context_size`. **Auto size** in Options picks the largest
context that fits in memory, up to 32768 tokens, then gives a quarter of it to
`max_tokens` and an eighth to `background_max_tokens`. With a separate
background model, it sizes that model on its own device as well and sets
`background_context_size` and `background_max_tokens` from it.

## Tools and safety

| Tool | Stage | Notes |
| --- | --- | --- |
| `web_search` | 2 | DuckDuckGo results via DDGS, capped by `max_search_results` |
| `web_fetch` | 2 | Public HTTP(S) pages only; private and local addresses are refused, including after redirects. The page is summarized for a focus the model supplies |
| `list_directory`, `read_file` | 2, 5 | Paths must stay under `filesystem_root` |
| `write_file` | 5 | Only with `allow_file_writes`; creates or replaces files and cannot delete |
| `run_tests` | 5 | Only with `enable_test_execution`; runs Python `unittest` discovery under the root with a 120-second limit |

`filesystem_root` is resolved from the current directory. Paths are relative to
it; an absolute path is accepted only when it points inside it. Files with
sensitive names such as `.env` or private keys are refused. Each tool stage may
make at most `max_tool_calls` calls (1 to 10).

### MCP servers

Explicitly configured MCP servers can provide extra tools to stage 5. Each
enabled server must list `allowed_tools`; only those are exposed, named
`mcp__<server>__<tool>`. Configure only servers you trust. Sessions open for the
stage and close after it.

Two transports are supported:

- **`stdio`** runs `command` with `args` locally. It inherits basic variables
  such as `PATH` and `HOME`; anything else goes in `env`.
- **`http`** connects to a Streamable HTTP endpoint at `url` and sends `headers`
  with every request.

Values in `env` and `headers` can reference process variables as `${NAME}`, so
secrets stay out of the file. A missing variable stops the stage with an error.

```json
{
	"mcp_servers": [
		{
			"name": "docs",
			"transport": "stdio",
			"command": "docs-mcp-server",
			"args": [],
			"env": {"DOCS_TOKEN": "${DOCS_TOKEN}"},
			"allowed_tools": ["search_docs", "fetch_doc"]
		},
		{
			"name": "trilium",
			"transport": "http",
			"url": "http://127.0.0.1:37840/mcp",
			"headers": {"Authorization": "Bearer ${TRILIUM_ETAPI_TOKEN}"},
			"allowed_tools": ["search_notes", "get_note", "get_note_content"]
		}
	]
}
```

Trilium serves MCP at `/mcp` once it is enabled in Options > AI / LLM, and
accepts an ETAPI token from Options > ETAPI as a bearer token.

## Project layout

| Path | Contents |
| --- | --- |
| `smartharness/task_tree.py` | The task tree: deciding, gathering, writing, checking, and splitting tasks |
| `smartharness/pipeline.py` | The eight stages, model loading, page summarization, and setup shared with the task tree |
| `smartharness/tool_stage.py` | The tool-calling loop used by stages 2 and 5 and by task tree tool steps |
| `smartharness/tools.py` | Built-in tools and their path and URL checks |
| `smartharness/mcp_tools.py` | MCP client for stdio and HTTP servers |
| `smartharness/context_budget.py` | Fitting stage input into the context window |
| `smartharness/knowledge.py` | SQLite knowledge store, queue, and graph |
| `smartharness/background.py` | One background research job |
| `smartharness/consolidation.py` | One background consolidation step: merging, re-filing, and pruning the store |
| `smartharness/settings.py` | Defaults and validation |
| `smartharness/daemon.py` | The daemon: model, runs, background worker, and socket server |
| `smartharness/client.py`, `smartharness/protocol.py` | Connecting to the daemon, starting it, and the message format |
| `smartharness/cli.py`, `smartharness/tui.py` | Command line and Textual interface |
| `smartharness/gtk_app.py` | GTK 4 interface |
| `smartharness/stages.py` | Stage labels and task tree lines shared by the interfaces |

See [docs/architecture.md](docs/architecture.md) for how these parts fit together.

Run the tests with `python -m unittest discover -s tests`.

## Current limits

- Subtasks run one after another, and a task tree is not resumed after the
  daemon restarts; the saved tree is a record, not a checkpoint.

- One-shot CLI runs without a daemon load the model for each run; the daemon
  keeps it loaded and shares it with the background worker.
- Topics found by searches during a request are named after the query and stay
  at the top level until the background worker researches them.

See `TODO.md` for planned work.

## License

GPL-3.0; see `LICENSE`.
