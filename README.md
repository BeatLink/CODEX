# SmartHarness

A harness that makes small, locally run LLMs more capable on tasks they would
otherwise fumble.

Small models struggle with long, multistep reasoning: they lose track of
constraints, skip requirements, and invent facts. SmartHarness never asks the
model to do the whole job at once. It breaks each request into stages, gives the
model one narrow goal per stage, and passes forward only the results that stage
needs. Alongside the pipeline, a local SQLite knowledge store keeps what the
harness has researched, and a background worker uses idle time to research and
refresh it, so the harness grows more useful the longer it runs.

Models run through `llama-cpp-python` from a local GGUF file. Nothing is sent to
a hosted model.

## How a request is handled

A request runs through up to eight stages. Each stage is a separate model call
with its own system prompt, and its input is the original request plus only the
earlier results it needs.

| Stage | Goal | Sees | Tools |
| --- | --- | --- | --- |
| 1. Identify | Return JSON listing the requirements, constraints, and assumptions, whether research or files are needed, search queries, the task type, and an optional clarification question | Request | none |
| 2. Research | Gather at most five findings | Stage 1, clarification, stored or searched evidence | `web_search`, `web_fetch`, `list_directory`, `read_file` |
| 3. Plan | Make an ordered plan covering every requirement, including any tool actions | Stages 1 and 2, evidence | none |
| 4. Review plan | Check the plan against the request before anything runs; output a corrected outline and the exact tool actions still needed | Stages 1 to 3, evidence | none |
| 5. Act | Carry out only the reviewed tool actions | Stage 4, evidence | file tools, `run_tests`, MCP tools (no web) |
| 6. Draft | Write the answer from the reviewed outline and action results | Stages 4 and 5, evidence | none |
| 7. Critique | Return JSON marking each requirement met, partly met, or missing, with a fix for each one not met, plus other issues | Stages 1 and 4 to 6, evidence | none |
| 8. Revise | Apply the corrections and return only the final answer | Stages 4 to 7, evidence | none |

Stage 1's reply is constrained by a JSON schema, which llama.cpp enforces as a
grammar, so even a small model returns a well-formed analysis. Its task type
picks the route:

| Task type | Stages run |
| --- | --- |
| `direct`: a short answer from general knowledge | 1, 6 |
| `reasoning`: multi-part analysis or writing without tools | 1, 3, 4, 6, 7, 8 |
| `research`: looked-up evidence is central | 1 to 4, 6 to 8 |
| `action`: files must change or tests run | all eight |

Stage 2 also runs on any route when stage 1 says research or file reading is
needed. Skipped stages are marked SKIP in the TUI. If stage 1's reply is not
valid JSON, every stage runs and research is decided by keywords in the prompt.

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
  tokenizer and trimmed to fit `context_size` minus that stage's reply budget.
  The original request is never trimmed unless it alone overflows the window;
  earlier results are shortened first. Stage 1 and the critique reply in at most
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
- **Episodes**: each finished request with its task type, checklist, any
  clarification, the answer, and how it ended (answered directly, passed the
  critique, revised, or failed).
- **Full-text indexes** (FTS5) over sources, and over facts and episodes.
- **A graph** of nodes and labelled edges. Topics link to child topics
  (`contains`) and to their sources (`supported_by`); entity relationships can
  carry the source that supports them.
- **A research queue** of pending, running, done, and failed jobs.

Before stage 1, the pipeline recalls what memory holds for the request: the
user memory, plus facts and past episodes that share at least half of the
prompt's search terms, ignoring common words. These go to stage 1 and the later
stages as "Remembered context", and each recall counts towards that fact's and
topic's use count. When the run ends, it is recorded as an episode.

Every web search the pipeline runs is stored under a topic named after its
query. A stored source is reused only while it has not expired and shares at
least half of the prompt's search terms. Only snippets and summaries are
stored, never full pages.

The schema is versioned, and an older database is upgraded in place when it is
opened; a database from a newer version is refused.

The database is local and not encrypted; choose a private path if other users
can read your files.

### Background research

While the TUI is open, a background worker researches queued topics whenever no
prompt is running. For each job it searches the web, summarizes the results
with the local model (citing each claim's URL), and stores the sources and
summary. It also re-queues topics whose research is older than
`background_refresh_interval_hours`.

The worker yields to foreground work: it waits for the shared model lock,
checks before every step and every generated token whether a prompt has
started, and if so puts its job back in the queue.

Topics reach the queue in two ways. A search during a request that finds
nothing is queued, so the worker tries it again later. Otherwise, add topics on
the Background page: **Queue topic** adds one to the queue, and **Research now** starts it at once, even
while idle research is paused. The worker stops when the TUI exits. One-shot
CLI runs read and write the knowledge store but do not start the worker.

`background_poll_interval_seconds` and `background_max_tokens` bound its
resource use, and `background_max_pending_jobs` bounds the backlog. Set
`background_research_enabled` to `false` to pause it.

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
```

### Terminal interface

The TUI has four pages:

- **Workbench**: write a request and run it with **Ctrl+R** or the Run button,
  and stop it with the Cancel button. The Output tab shows each stage's streamed
  output in its own tab and the final Markdown answer, which can be copied.
  Clarification questions appear as a dialog.
- **Background**: queue topics, start research now, pause or resume the worker,
  and watch its output and queue.
- **Options**: every setting, including model, folder access, tool limits, and
  background research. Changes can be saved back to the settings file.
- **Knowledge**: browse topics, stored sources and summaries, and graph
  relationships with their supporting URLs.

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
	"knowledge_db_path": "~/.local/share/smartharness/knowledge.sqlite3",
	"background_research_enabled": true,
	"background_poll_interval_seconds": 10,
	"background_refresh_interval_hours": 168,
	"background_max_tokens": 512,
	"background_max_pending_jobs": 100,
	"mcp_servers": []
}
```

Precedence, lowest first: built-in defaults, the settings file, the
`MODEL_PATH` environment variable, then command-line options.

| Option | Effect |
| --- | --- |
| `--model-path`, `--context-size`, `--gpu-layers`, `--max-tokens`, `--temperature` | Override the matching setting |
| `--allow-file-writes` | Let the model create or replace files |
| `--enable-test-execution` | Let the model run the project's tests |
| `--show-thinking` / `--no-show-thinking` | Stream or hide each stage's output |
| `--settings PATH` | Use another settings file |
| `--tui` | Open the terminal interface |

`max_tokens` is reserved for the reply in most stages, so it must leave room
for input within `context_size`.

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
| `smartharness/pipeline.py` | The eight stages, model loading, and page summarization |
| `smartharness/tool_stage.py` | The tool-calling loop used by stages 2 and 5 |
| `smartharness/tools.py` | Built-in tools and their path and URL checks |
| `smartharness/mcp_tools.py` | MCP client for stdio and HTTP servers |
| `smartharness/context_budget.py` | Fitting stage input into the context window |
| `smartharness/knowledge.py` | SQLite knowledge store, queue, and graph |
| `smartharness/background.py` | One background research job |
| `smartharness/settings.py` | Defaults and validation |
| `smartharness/cli.py`, `smartharness/tui.py` | Command line and Textual interface |

Run the tests with `python -m unittest`.

## Current limits

- One-shot CLI runs load the model for each run; the TUI keeps it loaded and
  shares it with the background worker.
- The topic tree is flat in practice: topics are named after search queries,
  nothing sets a parent, and nothing yet records entity relationships.
- The knowledge store holds web evidence only, not facts about the user or
  past tasks.

See `TODO.md` for planned work.

## License

GPL-3.0; see `LICENSE`.
