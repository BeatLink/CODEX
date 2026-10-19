# SmartHarness
A simple coding harness to make locally run LLM models smarter by breaking prompts down and utilizing self prompting

## Configuration

Runtime options are read from `settings.json` next to `harness.py`:

```json
{
	"model_path": "./models/model.gguf",
	"context_size": 4096,
	"gpu_layers": -1,
	"max_tokens": 1024,
	"temperature": 0.1
}
```

You can use a different settings file with `--settings path/to/settings.json`.
Precedence is defaults, `settings.json`, the `MODEL_PATH` environment variable,
then explicit command-line options. Supported command-line overrides are
`--model-path`, `--context-size`, `--gpu-layers`, `--max-tokens`, and
`--temperature`.

Run with a prompt as an argument, enter one interactively, or pipe it through
standard input:

```bash
python main.py "Explain how to design a local event logging daemon"
python main.py
echo "Summarize this design" | python main.py
```
