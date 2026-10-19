# SmartHarness
A simple coding harness to make locally run LLM models smarter by breaking prompts down and utilizing self prompting

## Configuration

Runtime options are read from `settings.json` in the project root:

```json
{
	"model_path": "./models/model.gguf",
	"context_size": 4096,
	"gpu_layers": -1,
	"max_tokens": 1024,
	"temperature": 0.1,
	"filesystem_root": ".",
	"max_tool_calls": 5,
	"max_search_results": 5
}
```

You can use a different settings file with `--settings path/to/settings.json`.
Precedence is defaults, `settings.json`, the `MODEL_PATH` environment variable,
then explicit command-line options. Supported command-line overrides are
`--model-path`, `--context-size`, `--gpu-layers`, `--max-tokens`, and
`--temperature`.

The tool stage can search the web using DDGS and list, read, or write files.
`filesystem_root` is resolved from the current working directory; file tools
cannot access paths outside that root. Writes can create or replace files but
cannot delete them. Tool calls and search results are capped by the settings.

The harness is available as an importable `smartharness` package. Run it with a
prompt as an argument, enter one interactively, or pipe it through standard
input:

```bash
python -m smartharness "Explain how to design a local event logging daemon"
python -m smartharness
echo "Summarize this design" | python -m smartharness
```
