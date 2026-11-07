# Model trials, 2026-11-06 and 2026-11-07

Raw output of the Spark-X2.6-4B against Qwen3.5-4B comparison that made Spark the reference model. The table that summarises these runs is in `docs/3-roadmap.md`, "Model results"; the Phi-4-mini result is in `docs/done/done-phi-4-mini-as-generalist.md`.

Each `--output` file holds every answer, score, failed check and tool call; each log is what the run printed. The Qwen3.5-4B model files are deleted, so these cannot be reproduced for Qwen.

| Folder | Set and runners | Models | Build | Files |
|---|---|---|---|---|
| `agents/` | `evals/agents_tasks.json`, `tree,agents`, `--repeat 3` | Spark-X2.6-4B-Q4_K_M, Qwen3.5-4B-UD-Q4_K_XL | `c702aa7` | `spark-full.*`, `qwen-full.*` |
| `reasoning/` | `evals/reasoning_tasks.json`, `bare,tree`, `--repeat 3` | the same two | `bbac823` | `spark-reasoning.*`, `qwen-reasoning.*` |
| `phi-smoke/` | `inbox-newest` only, `tree,agents` | Phi-4-mini-instruct-Q4_K_M, stopped by hand | `58d7927` | `phi-smoke.log` (live stream; no JSON, the run was killed) |

All on the RTX 3050 Ti Laptop GPU with every layer on CUDA at the 6,144-token context. Absolute paths were removed from the logs. The first Spark smoke run (CPU after a GPU firmware crash) is not kept; it is described in doc 2.

Re-run a model with `evals/run_model_trial.sh MODEL.gguf OUTPUT_DIR`.
