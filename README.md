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
- Loading a model with layers on the GPU takes the lock file
  `$XDG_RUNTIME_DIR/smartharness-gpu.lock` and holds it until that model is
  unloaded, so two programs never fill the GPU at once (llama.cpp aborts the
  whole process when the GPU runs out of memory). A load waits up to 30
  minutes for another holder, and an interface shows "Waiting for the GPU"
  meanwhile. Other programs can share the GPU the same way with
  `flock "$XDG_RUNTIME_DIR/smartharness-gpu.lock" command`; SmartHarness
  started under such a command uses the lock it was given. Models with no GPU
  layers, such as the embedding model, never take it.
  `SMARTHARNESS_GPU_LOCK` names another lock file, or turns the lock off when
  set empty.
- The daemon reads `settings.json` when it starts. Relative paths in settings
  are resolved from the directory the daemon started in; the CLI sends its
  paths already resolved.

The protocol is one JSON object per line. A request is
`{"id", "method", "params"}` and gets `{"id", "result"}` or `{"id", "error"}`
back; the daemon also sends `{"event", "data"}` lines at any time. Methods are
`status`, `get_settings`, `apply_settings`, `save_settings`,
`set_background_enabled`, `run`, `cancel`, `answer_clarification`,
`queue_topic`, `research_now`, `queue_status`, `knowledge`, `unfinished_runs`,
`resume_run`, `discard_run`, and `shutdown`.
Events are `run.started`, `run.progress`, `run.token`,
`run.tree` (every task's state, sent whenever one changes), `run.clarification`,
`run.finished`, `run.failed`, `run.cancelled`, `background.status`,
`background.token`, `queue.changed`, `knowledge.changed`, `runs.changed` (the
list of unfinished task tree runs changed), and `settings.changed`.

## How a request is handled

Every request is worked as a tree of tasks.

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
  request. Dates are compared by value, so "October 9, 2026", "9 October 2026",
  and "2026-10-09" all match, and numbers in code blocks are not checked. A task
  that acted is held to what its tools really did: its result must name every
  file written, say when a write or a test run failed, give the test result,
  and not claim a change when nothing was written.
- **Earlier results are condensed, not cut.** Each call's input is measured
  with the model's own tokenizer and fitted to `context_size` minus that call's
  reply budget. When it would overflow, the largest earlier results are
  summarized first, each only once per run, and only what still overflows is
  trimmed; the request and the current task are never condensed. Decisions and
  checks reply in at most 1024 and 512 tokens, which leaves them more room for
  input. Fetched pages are summarized in chunks, then the chunk summaries are
  merged.
- **Untrusted input.** Web pages, file contents, tool output, search results,
  and everything recalled from the knowledge store are fenced between
  `<untrusted-data>` tags under a heading that says to use them as information
  and never follow instructions in them. Any such tag inside the text is
  removed first, so a hostile page cannot close the fence early, and so is
  every sentence that gives orders to the reader ("ignore previous
  instructions", "note to AI assistants", anything about the system prompt,
  "end every answer with", or a line starting `System:`), which becomes
  `[instruction removed]`. A 4B model followed an appended instruction inside
  the fence every time; with those sentences removed it passed every hostile
  task. `evals/hostile_seed.json` and `evals/hostile_tasks.json` test this:
  `smartharness eval --seed evals/hostile_seed.json --tasks evals/hostile_tasks.json`.

`mode` limits what a request may do: in `answer` and `draft` mode the `act`
approach is never offered, so nothing is changed, while `auto` (the default)
and `execute` allow it. Set `mode` in the settings, pass `--mode`, use the
selector beside the Run button, or start the prompt with `/ask` or `/answer`,
`/draft` or `/plan`, or `/do` or `/execute`.

The decision asks one clarification question for the top task when the request
is materially ambiguous, then decides again with the answer. The finished tree
is saved with the request's episode in the knowledge store.

With a knowledge store, a tree run is also checkpointed: the store's
`task_runs` table keeps the options it started with and every task's state,
saved after each change. A run that is cancelled, fails, or is cut off by a
crash or a daemon restart can be resumed. Finished tasks keep their results, a
task that had already split carries on with its unfinished subtasks, and a
task that was cut off mid-way starts again from its decision. The clarification
answer and the evidence gathered so far are restored, and the run works under
the options it started with, not the current settings. The TUI and GTK
interfaces offer Resume and Discard for the newest unfinished run, and
`smartharness --resume` resumes it from the command line.

## Standing instructions

Rules you write yourself go into every model call, after the request, and are
never condensed or trimmed before the earlier results are. SmartHarness reads
two files, in this order:

- `~/.config/smartharness/SMARTHARNESS.md` (under `$XDG_CONFIG_HOME` when it
  is set), for rules that hold everywhere.
- `SMARTHARNESS.md` in `filesystem_root`, or `AGENTS.md` when there is none,
  for rules about that folder, such as how its tests run.

Together they are cut at 4000 characters, since a small model's window has
little room to spare. Keep each rule short and plain; a small model follows a
written rule far more reliably than one it has to work out.

## Commands

A prompt may start with a command. Besides the mode prefixes (`/ask`, `/plan`,
`/do`, and the rest), these work in every interface:

| Command | What it does |
| --- | --- |
| `/remember [kind] statement [Why: reason]` | Stores a memory you state yourself, without the model. The kind is `preference` (the default), `project`, `correction`, or `reference`. A `project` memory belongs to the current folder; the others hold everywhere. A stated memory outlasts a learned one it contradicts |
| `/memories` | Lists the memories for the current folder, with their numbers |
| `/forget number` or `/forget words` | Deletes one memory, by its number or by words from it; when several match, they are listed instead |
| `/init` | Reads the folder and writes its `SMARTHARNESS.md`, or improves the one there. With file writes off, it replies with the text instead |

Define your own commands as Markdown files named after the command, in
`~/.config/smartharness/commands/` or the folder's `.smartharness/commands/`
(which wins when both have one of the same name). `/review parser.py` runs
`review.md`:

```markdown
---
description: Review code for bugs
mode: draft
---
Review $ARGUMENTS for bugs and list each with the line it is on.
```

`$ARGUMENTS` is replaced by the words after the command, which otherwise
follow the template. `mode` (`answer`, `draft`, or `execute`) is optional; a
command in `answer` or `draft` mode never changes a file. A prompt starting
with an unknown command, or with a path such as `/etc/hosts`, is left as it
is.

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
- **User memory**: preferences, projects, corrections, and references (where
  something lives, such as a URL or host) about the user, each with an
  optional reason it holds. A memory is either learned from past requests or
  stated by the user, and a project memory belongs to the folder
  (`filesystem_root`) its requests were worked in.
- **Episodes**: each finished request with its mode, its task tree, any
  clarification, the answer, and how it ended (how many tasks met their
  deliverable, and how many were unverified or failed).
- **Full-text indexes** (FTS5) over sources, and over facts and episodes.
- **Embeddings** of facts and topics, for finding them by meaning.
- **A graph** of nodes and labelled edges. Topics link to child topics
  (`contains`) and to their sources (`supported_by`); entity relationships can
  carry the source that supports them.
- **A research queue** of pending, running, done, and failed jobs.

Before the first model call, the request recalls what memory holds for it: up
to ten user memories, global ones and those of the current folder, sharing the
most words with the request first, then those the user stated, then the
newest, so a new memory is never crowded out by older ones; plus facts and past episodes that share at least half of the
prompt's search terms, or three of them for a longer prompt, ignoring common
words; those sharing the most terms come first. When fewer than five match and
the request names a stored topic (every word of the topic's name appears in
it), the rest come from that topic and its subtopics, most relevant, trusted,
and used first. With an embedding model (see below), facts are also found by
meaning, even when they share no words with the request, and the two rankings
are merged; when the request names no topic, the topic closest in meaning
supplies the branch. These go to every later step as
"Remembered context", and each recall counts towards that fact's and topic's use
count. In a task tree, each subtask also recalls facts for its own prompt, and
each search query recalls facts for itself; facts that answer every query of a
task let it skip its tool loop, as stored summaries do. Recalled facts count as
evidence when checking cited URLs and values. Each recalled fact shows when its
source was retrieved; once that source has expired, the fact is marked as
possibly out of date, no longer lets a task skip its web research, and its
topic is queued for fresh research. When the run ends, it is recorded as an
episode.

### Search by meaning

`embedding_model_path` (`./models/embedding.gguf` by default) points at a small
embedding model, run on the CPU so the GPU stays with the chat model.
[Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF)
in Q8_0 (about 640 MB) is the one this was built with. While idle, the
background worker embeds facts and topics in batches of eight, and embeds a
topic again when its summary changes. Vectors are stored in the knowledge
database and searched with sqlite-vec. Consolidation also compares topics,
and facts under one topic, whose vectors are close, so duplicates worded
differently are merged too. Without the file, or if it fails to load, search
stays word-based.

Every web search a request runs is stored under a topic named after its
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

1. Searches the web, then fetches and summarizes the first two result pages,
   skipping one whose text matches a page already read.
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
3. Stores the sources, page summaries, facts, and relationships. Summary
   sentences stating a version or date no source contains are dropped, and the
   topic's place in the tree is left to consolidation.

When a fact is recalled later, it comes with the chain of topics above it and
their summaries, so the model gets the broader picture in a few lines, and with
up to five stored relationships of the named things it mentions.

With no research queued, the worker reads recent requests that have not been
processed yet and remembers what they show about the user: preferences,
projects, corrections, and references, with a reason when the requests give
one. Each pass reads requests from one folder, and the project memories it
learns stay with that folder. It is told to leave out secrets and personal
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
well, led by the start of the request it answers so the search knows its
subject, up to three per check, so the claim gets looked up. A page fetched during
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
- When the store's data passes `background_max_store_megabytes` (1024 by
  default), the least valuable rows are deleted until it is back under 90% of
  that size: pruned facts first, then finished task runs, processed episodes,
  expired sources no fact cites, and last the least used facts. User memories
  and topics are never evicted. Freed space is reused by SQLite rather than
  returned to the disk.

Then the model gives each topic still called by the search query that found it,
or with a name over five words or 40 characters, such as "how do i use fts5 in
sqlite", a title as short as a chat title, such as "SQLite FTS5", from its
summary and facts. A name that another topic already has merges the two, and
each topic is named once. A renamed topic and its subtopics are placed again,
since they were placed under the old name. A renamed topic with no facts is researched again
under its new name, and one that names no subject at all, such as a sentence
copied from an answer that gives a screen size but never says which product it
means, is removed when it holds no facts or subtopics; its
sources stay.

The model then compares pairs that share at least half their words, one pair
per call, with a schema that lets it reply only with a short reason and one
verdict:

| Pair | Verdicts | What happens |
| --- | --- | --- |
| Two topics | same subject, first is broader, second is broader, different | Same subjects are merged into the one with more facts and sources, carrying over its facts, sources, subtopics, queued research, and graph edges. A broader topic adopts the narrower one when that narrows where it sits now |
| Two facts under one topic | same, contradict, different | Same facts are merged into the more trusted one. Of two contradicting facts the less trusted is marked disputed, or both when neither is more trusted, and the topic is queued for fresh research |
| Two user memories | same, contradict, different | Same memories are merged. Of two contradicting memories the older is set aside, except that one the user stated outlasts a learned one. Project memories are compared only with global ones and those of their own folder |

Disputed and pruned facts and set-aside memories are no longer recalled. Each
pair is compared once; its verdict is stored, and a fact or memory learned
again after being set aside is compared afresh.

Each topic's place in the tree is also reviewed once every
`background_refresh_interval_hours`. The model picks the narrowest of up to 20
related topics that this one is a kind of or part of, or the top level, from a
list fixed by the schema; its own subtopics are never offered. A researched
topic may instead name a broader subject the tree lacks, such as "Pine64" for
"PinePhone" beside "PineTime"; that topic is made where this one sat and is
placed in its own turn, and a topic made this way never names one above itself.
When a topic moves, the summaries of its new and old parents are rewritten.
Research never files a topic itself, so the tree is shaped only here.

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

Then put a GGUF model at `./models/model.gguf`, or point `model_path` at one,
and optionally an embedding model at `./models/embedding.gguf` (see
[Search by meaning](#search-by-meaning)).

## Usage

```bash
smartharness "Explain how to design a local event logging daemon"
echo "Summarize this design" | smartharness
smartharness            # opens the TUI when run in a terminal
smartharness --tui      # or: smartharness-tui
python -m smartharness  # same as smartharness
smartharness-gtk        # open the GTK interface
smartharness-daemon     # run the daemon in the foreground
smartharness --resume   # carry on the newest unfinished task tree run
smartharness eval       # compare the bare model and the task tree
```

### Evaluation

`smartharness eval` answers each task in `evals/tasks.json` with the bare model
(one call with a plain system prompt) and with the task tree, both on one
loaded model. Each answer is scored by checks that do not use
the model: `contains`, `contains_any`, `not_contains`, `regex`, `not_regex`,
`max_words`, and `min_words`. It prints each result as it lands, then a table of passed
tasks, passed checks, errors, seconds, model calls, and generated tokens per
runner.

Each run gets an empty knowledge store and an empty scratch directory as its
filesystem root, with no MCP servers, so no task sees what an earlier one found
or the user's own files. Web search stays on.

`evals/hard_tasks.json` holds tasks a small model tends to get wrong on its
own: counting letters, multi-step arithmetic and dates, a logic puzzle, facts
that need a search, and writing under several exact constraints.

`evals/execute_tasks.json` holds execute-mode tasks. Each one carries `files`,
a small project written into the scratch root before the run, and the task
tree may change those files and run their tests. The bare model gets
the files inline and gives back each file it changes in full, as a
`File: <path>` line and a fenced block, which is written into the root before
scoring. Three more checks look at the files after the run: `tests_pass` runs
unittest discovery as the `run_tests` tool does, `file_contains` looks for text
in one file, and `file_unchanged` fails when a file such as a test differs from
how the task gave it.

`--seed-store PATH` measures what recall adds: the task tree runs once more,
as `tree+store`, starting from a fresh
copy of that knowledge store, such as the one in `knowledge_db_path`. The copy
is made with SQLite's backup, so the seed store itself is never changed.

`--seed` builds that store from `evals/seed.json`, or from a seed file it
names, and answers `evals/recall_tasks.json` unless `--tasks` names another
set. The seed holds made-up facts about a lab that does not exist, with their
sources and two user memories, so no web search can answer the recall tasks
and only recall can. One task asks about something the seed leaves out, to
catch an answer that borrows a nearby fact. When `embedding_model_path` names
a model, the facts and topics are embedded as the store is built, and every
run recalls by meaning as well as by words.

```bash
smartharness eval --runners bare,tree --only stable-fact,python-bug
smartharness eval --tasks my-tasks.json --output report.json
smartharness eval --tasks evals/execute_tasks.json
smartharness eval --tasks evals/hard_tasks.json
smartharness eval --runners tree --seed-store ~/.local/share/smartharness/knowledge.sqlite3
smartharness eval --seed --runners tree
```

### Recall benchmark

`smartharness recall-benchmark` scores recall itself, with no chat model. It
builds a store from the made-up facts in `evals/recall_benchmark_seed.json`,
asks each question in `evals/recall_benchmark.json`, and compares the five
facts recalled with the ones each question expects. Questions come in four
kinds: ones that share words with their fact, paraphrases that share none,
ones that should bring up several facts, and unrelated ones that should bring
up nothing. It runs once by words alone and once with the embedding model, and
reports each kind's pass rate, the share of expected facts found, the mean
reciprocal rank, and the time per recall. `--words-only` skips the embedding
run and `--show-failures` lists what each failed question recalled.

On 2026-10-21, with Qwen3-Embedding-0.6B on a busy CPU:

| | Words only | With meaning |
| --- | --- | --- |
| Shared words | 100% | 100% |
| Paraphrase | 0% | 100% |
| Several facts | 50% | 100% |
| Unrelated (nothing recalled) | 100% | 100% |
| Expected facts found | 38% | 100% |
| Mean reciprocal rank | 0.35 | 0.91 |
| Seconds per recall | 0.00 | 2.29 |

### Terminal interface

The TUI has four pages:

- **Workbench**: write a request, pick a mode, and run it with **Ctrl+R** or
  the Run button, and stop it with the Cancel button. The sidebar shows the
  live task tree with each task's state (WAIT, NOW, DONE, WARN for unverified,
  FAIL), the Steps tab streams every step under its own heading, and choosing a
  task in the tree opens the Task tab with its deliverable, state, note, and
  result. The Final tab shows the Markdown answer, which can be
  copied.
  Clarification questions appear as a dialog. When a task tree run was left
  unfinished, a bar under the Run button names it and how many of its tasks are
  done, with Resume and Discard buttons.
- **Background**: queue topics, start research now, pause or resume the worker,
  and watch its output and queue.
- **Options**: every setting, including model, task tree limits, folder access, tool limits,
  background research, and the MCP server list, edited as JSON. Changes can be
  saved back to the settings file. **Auto size** reads the model file and free
  GPU memory (or RAM without a GPU) and fills in the context size and both token
  limits; apply or save them.
- **Knowledge**: browse topics, stored sources and summaries, and graph
  relationships with their supporting URLs.

### GTK interface

`smartharness-gtk` has the same four pages in a GTK 4 window that follows the
desktop's GTK theme. On the Workbench page the list on the left shows the
live task tree and a Steps page with every step's output; choosing an entry shows its output, and choosing a task shows
its deliverable, state, note, and result. The final answer's
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
	"confirm_actions": true,
	"show_thinking": true,
	"mode": "auto",
	"max_task_depth": 3,
	"max_task_nodes": 20,
	"knowledge_db_path": "~/.local/share/smartharness/knowledge.sqlite3",
	"embedding_model_path": "./models/embedding.gguf",
	"background_research_enabled": true,
	"background_model_path": "",
	"background_context_size": 0,
	"background_gpu_layers": 0,
	"background_poll_interval_seconds": 10,
	"background_refresh_interval_hours": 168,
	"background_max_tokens": 512,
	"background_max_pending_jobs": 100,
	"background_prune_after_days": 90,
	"background_max_store_megabytes": 1024,
	"mcp_servers": []
}
```

`max_task_depth` (0 to 6) is how many levels of subtasks may sit below the top
task, and `max_task_nodes` (1 to 60) caps the tasks in one tree, the top task
included. Each task takes three to six model calls, so these bound how long a
request can run.

With `confirm_actions` on, the default, an interactive run asks you before it
changes a file, runs tests, or calls an MCP tool. It shows the first task
that would act, with the outline of the whole tree, and your answer covers the
rest of the run. A reply starting with yes, ok, go, or sure approves; any other reply
declines, nothing is run, and the answer says so. A run with no one to ask,
such as piped CLI input, goes ahead as `allow_file_writes` and
`enable_test_execution` allow.

Precedence, lowest first: built-in defaults, the settings file, the
`MODEL_PATH` environment variable, then command-line options.

| Option | Effect |
| --- | --- |
| `--model-path`, `--context-size`, `--gpu-layers`, `--max-tokens`, `--temperature` | Override the matching setting |
| `--allow-file-writes` | Let the model create or replace files |
| `--enable-test-execution` | Let the model run the project's tests |
| `--show-thinking` / `--no-show-thinking` | Stream or hide each step's output |
| `--mode auto\|answer\|draft\|execute` | Limit what the request may do; only `auto` and `execute` may change files |
| `--settings PATH` | Use another settings file |
| `--tui` | Open the terminal interface; the other options are applied to the daemon it connects to |

`max_tokens` is reserved for the reply in most steps, so it must leave room
for input within `context_size`. **Auto size** in Options picks the largest
context that fits in memory, up to 32768 tokens, then gives a quarter of it to
`max_tokens` and an eighth to `background_max_tokens`. With a separate
background model, it sizes that model on its own device as well and sets
`background_context_size` and `background_max_tokens` from it.

## Tools and safety

| Tool | Approach | Notes |
| --- | --- | --- |
| `web_search` | research | DuckDuckGo results via DDGS, capped by `max_search_results` |
| `web_fetch` | research | Public HTTP(S) pages only; private and local addresses are refused, including after redirects. The page is summarized for a focus the model supplies |
| `list_directory`, `read_file` | research, files, act | Paths must stay under `filesystem_root` |
| `write_file` | act | Only with `allow_file_writes`; creates or replaces files and cannot delete |
| `run_tests` | act | Only with `enable_test_execution`; runs Python `unittest` discovery under the root with a 120-second limit |

`filesystem_root` is resolved from the current directory. Paths are relative to
it; an absolute path is accepted only when it points inside it. Files with
sensitive names such as `.env` or private keys are refused. Each task's tool
loop may make at most `max_tool_calls` calls (1 to 10).

### MCP servers

Explicitly configured MCP servers can provide extra tools to tasks that act. Each
enabled server must list `allowed_tools`; only those are exposed, named
`mcp__<server>__<tool>`. Configure only servers you trust. Sessions open for a
task's tool loop and close after it.

Two transports are supported:

- **`stdio`** runs `command` with `args` locally. It inherits basic variables
  such as `PATH` and `HOME`; anything else goes in `env`.
- **`http`** connects to a Streamable HTTP endpoint at `url` and sends `headers`
  with every request.

Values in `env` and `headers` can reference process variables as `${NAME}`, so
secrets stay out of the file. A missing variable stops the task with an error.

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
| `smartharness/model.py` | Loading the model and making one call to it |
| `smartharness/evidence.py` | Searching with memory, recall formatting, page summaries, and the research queue |
| `smartharness/checks.py` | Checks on a result that do not rely on the model |
| `smartharness/tool_stage.py` | The tool-calling loop each task's gather step runs |
| `smartharness/tools.py` | Built-in tools and their path and URL checks |
| `smartharness/mcp_tools.py` | MCP client for stdio and HTTP servers |
| `smartharness/context_budget.py` | Fitting each call's input into the context window |
| `smartharness/knowledge.py` | SQLite knowledge store, queue, and graph |
| `smartharness/recall_benchmark.py` | Scoring recall against questions with known relevant facts |
| `smartharness/embeddings.py` | The embedding model used to find facts and topics by meaning |
| `smartharness/background.py` | One background research job |
| `smartharness/consolidation.py` | One background consolidation step: merging, re-filing, and pruning the store |
| `smartharness/settings.py` | Defaults and validation |
| `smartharness/daemon.py` | The daemon: model, runs, background worker, and socket server |
| `smartharness/client.py`, `smartharness/protocol.py` | Connecting to the daemon, starting it, and the message format |
| `smartharness/cli.py`, `smartharness/tui.py` | Command line and Textual interface |
| `smartharness/gtk_app.py` | GTK 4 interface |
| `smartharness/evaluation.py`, `evals/tasks.json` | The eval harness and its fixed task set |
| `evals/seed.json`, `evals/recall_tasks.json` | The seed store's made-up facts and the tasks only recall can answer |
| `smartharness/task_view.py` | Task tree lines and task details shared by the interfaces |

See [docs/architecture.md](docs/architecture.md) for how these parts fit together.

Run the tests with `python -m unittest discover -s tests`.

## Current limits

- Subtasks run one after another. Resuming restarts the task that was cut off
  from its decision, so the work it had done before the stop is redone.

- One-shot CLI runs without a daemon load the model for each run; the daemon
  keeps it loaded and shares it with the background worker.
- Topics found by searches during a request are named after the query and stay
  at the top level until the background worker researches them.

See `TODO.md` for planned work.

## License

GPL-3.0; see `LICENSE`.
