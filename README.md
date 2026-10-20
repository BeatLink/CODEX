# SmartHarness

A simple coding harness to make locally run LLM models smarter by breaking prompts down and utilizing self prompting

## Configuration

Runtime options are read from `settings.json` in the project root:

```json
{
	"model_path": "./models/model.gguf",
	"context_size": 4096,
	"gpu_layers": -1,
	"max_tokens": 2048,
	"temperature": 0.1,
	"filesystem_root": ".",
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

You can use a different settings file with `--settings path/to/settings.json`.
Precedence is defaults, `settings.json`, the `MODEL_PATH` environment variable,
then explicit command-line options. Supported command-line overrides are
`--model-path`, `--context-size`, `--gpu-layers`, `--max-tokens`, and
`--temperature`. `--enable-test-execution` opts in to the test-running tool.
Stage output streams by default; set `show_thinking` to `false` in
`settings.json` or pass `--no-show-thinking` to disable it. Use
`--show-thinking` to enable it for a single run.

The tool stage can search the web using DDGS and list, read, or write files.
Prompts asking to verify/research facts or configure a technical integration
automatically run a web search before the model-controlled tool stage.
`filesystem_root` is resolved from the current working directory; file tools
cannot access paths outside that root. Writes can create or replace files but
cannot delete them. Tool calls and search results are capped by the settings.
Later stages ground researched claims only in captured titles, URLs, and
snippets; pages are not fetched for independent verification. If search fails
or returns no useful evidence, the harness instructs the model to say that the
claims could not be verified. The model asks one concise clarification question in interactive
terminal sessions when it finds a material ambiguity; otherwise it proceeds
with an explicit assumption.

## Knowledge Store and Background Research

Search results are stored in a local SQLite database at `knowledge_db_path`.
The database keeps source URLs, titles, snippets, summaries, search queries,
retrieval timestamps, and expiry times. SQLite FTS5 is used for retrieval;
topic hierarchy and evidence-linked relationships are stored as graph nodes
and edges in the same database. Fresh local evidence is used before live search
for research-intent prompts. Expired or missing evidence falls back to web
search. Search results contain snippets only; pages are not fetched or
independently verified.

When the TUI is open, its Background page can queue research topics and control
the idle worker. The worker refreshes previously researched topics after
`background_refresh_interval_hours`, summarizes search snippets with the local
model, and pauses when a foreground prompt starts. Its model output and queue
state are visible in the TUI. The worker stops when the TUI exits; one-shot CLI
runs can read and write the knowledge store but do not start a persistent
background process. No topics are invented automatically: add a topic in the
Background page to queue it. Research can perform network searches, and
research-intent prompts may store their search query and returned evidence in
the configured database. Disable `background_research_enabled` to pause idle
research. Poll interval and generation token limit bound background resource
use; `background_max_pending_jobs` bounds the queued backlog.

The Knowledge page browses topics, stored sources, summaries, and graph
relationships with their supporting URLs. The database is local and is not
encrypted; choose a private path if local filesystem access is shared.

Test execution is disabled by default. When enabled through
`enable_test_execution` or `--enable-test-execution`, the model can run Python
`unittest` discovery under `filesystem_root`. Tests run with a 120-second limit;
project test code executes locally.

MCP support currently accepts explicitly configured stdio servers. Each
enabled server must include an `allowed_tools` list; only those discovered
tools are exposed to the model. The server command runs locally, so configure
only servers you trust. Environment values can reference process variables
with `${NAME}` instead of putting secrets in this file. The process inherits
basic runtime variables such as `PATH` and `HOME`; other values must be
configured explicitly:

```json
{
	"mcp_servers": [
		{
			"name": "docs",
			"enabled": true,
			"transport": "stdio",
			"command": "docs-mcp-server",
			"args": [],
			"env": {"DOCS_TOKEN": "${DOCS_TOKEN}"},
			"allowed_tools": ["search_docs", "fetch_doc"]
		}
	]
}
```

MCP tools are named `mcp__<server>__<tool>` to avoid collisions with built-in
tools. Server sessions are opened for the tool stage and closed afterward.
Only stdio transport is supported; network transports are not yet available.

The harness is available as an importable `smartharness` package. Run it with a
prompt as an argument, enter one interactively, or pipe it through standard
input:

```bash
python -m smartharness "Explain how to design a local event logging daemon"
python -m smartharness
echo "Summarize this design" | python -m smartharness
```

In a terminal, launch `smartharness` without a prompt to open the interactive
Textual interface. You can also launch it explicitly with `smartharness --tui`
or `smartharness-tui`; the TUI lets you edit runtime settings, follow pipeline
stage progress, inspect each phase's streamed output in its own tab, answer
clarification questions, configure background research, browse stored
knowledge, and read or copy the final Markdown response. Use
`--settings path/to/settings.json` to select a settings file; TUI changes can
be saved back to that file.
