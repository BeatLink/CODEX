# Model trials, 2026-11-06 and 2026-11-07

Raw output of the Spark-X2.6-4B against Qwen3.5-4B comparison that made Spark the reference model, and of the overnight trial of Qwen3.5-9B, Qwen3.5-35B-A3B and Qwen3-14B (2026-11-07). The table that summarises these runs is in `docs/3-roadmap.md`, "Model results"; the Phi-4-mini result is in `docs/done/done-phi-4-mini-as-generalist.md`; the 9B, MoE and 14B record is in `docs/done/research-9b-moe-and-14b-trials.md`.

Each `--output` file holds every answer, score, failed check and tool call; each log is what the run printed. The Qwen3.5-4B model files are deleted, so these cannot be reproduced for Qwen.

| Folder | Set and runners | Models | Build | Files |
|---|---|---|---|---|
| `agents/` | `evals/agents_tasks.json`, `tree,agents`, `--repeat 3` | Spark-X2.6-4B-Q4_K_M, Qwen3.5-4B-UD-Q4_K_XL | `c702aa7` | `spark-full.*`, `qwen-full.*` |
| `reasoning/` | `evals/reasoning_tasks.json`, `bare,tree`, `--repeat 3` | the same two | `bbac823` | `spark-reasoning.*`, `qwen-reasoning.*` |
| `agents/` | the same, `--repeat 3` | Qwen3.5-9B-Q4_K_M, 17 of 33 layers on the GPU | `f0f5cef` | `qwen9b-agents.*` |
| `reasoning/` | the same, `--repeat 3` | Qwen3.5-9B-Q4_K_M, 17 layers | `f0f5cef` | `qwen9b-reasoning.*` |
| `scaled/` | `evals/scaled_tasks.json`, `tree,agents`, `--repeat 3` | Qwen3.5-9B-Q4_K_M, 17 layers | `f0f5cef` | `qwen9b-scaled.*` |
| `probes/` | `inbox-newest` only, `tree`, one round | Qwen3.5-9B at 20, 18, 17 and 16 GPU layers (20 and 18 fail to create the context) | `f0f5cef` | `probe-9b-l*.log` |
| `blueprints/` | `blueprint_tasks.json` (four blueprint requests), `bare`, one round, `--prompts blueprints/prompts` (the blueprint system prompt), `max_tokens` 3,072 | Qwen3.5-35B-A3B-UD-IQ3_S (9 layers), Qwen3.5-9B-Q4_K_M (17), Qwen3-14B-Q4_K_M (12), Spark-X2.6-4B-Q4_K_M (all) | `f0f5cef` | `moe35b.*`, `qwen9b.*`, `qwen14b.*`, `spark4b.*` |
| `moe-tuning/` | `tune_task.json` (the free-slot blueprint request), `bare`, `--repeat 2`, one llama.cpp setting changed per run | Qwen3.5-35B-A3B-UD-IQ3_S | `f0f5cef` plus an uncommitted patch that read the settings from environment variables | `moe-*.json`, `moe-*.log` (`moe-t12-l4` was stopped by hand, `moe-base-l10` ran out of GPU memory) |
| `phi-smoke/` | `inbox-newest` only, `tree,agents` | Phi-4-mini-instruct-Q4_K_M, stopped by hand | `58d7927` | `phi-smoke.log` (live stream; no JSON, the run was killed) |

All on the RTX 3050 Ti Laptop GPU at the 6,144-token context, with every layer on CUDA unless a row names a layer count; the rest of such a model runs on the CPU. Absolute paths were removed from the logs. The first Spark smoke run (CPU after a GPU firmware crash) is not kept; it is described in doc 2.

Re-run a model with `evals/run_model_trial.sh MODEL.gguf OUTPUT_DIR`.
