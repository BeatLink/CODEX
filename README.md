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
clarification questions, and read or copy the final Markdown response. Use
`--settings path/to/settings.json` to select a settings file.
