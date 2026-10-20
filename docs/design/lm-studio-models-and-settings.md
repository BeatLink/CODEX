# LM Studio and Hermes: models and non-default settings

Record written 2026-10-20, when LM Studio and Hermes Agent were removed from the TechNet flake (commit "feat(odin): remove Hermes and LM Studio"). It keeps the models that were chosen, the settings that differed from the defaults, and the measurements behind them, so they can be reused in SmartHarness. The hardware is the same laptop described in [model-selection-and-background-model.md](model-selection-and-background-model.md): RTX 3050 Ti with 3.68 GiB usable VRAM, Ryzen 5 5600H with 6 cores / 12 threads.

The model files are still on disk under `/Storage/Apps/AI/LMStudio/home/.lmstudio/models` (51 GB), with parked vision projectors in `.lmstudio/disabled-mmproj`. The TechNet backup excludes for those folders were kept, so the files stay out of borg until they are deleted.

## Models

### Declared in the flake

The flake downloaded these from Hugging Face on login.

| Repository | File | Role |
|---|---|---|
| `lmstudio-community/Qwen3.5-4B-GGUF` | `Qwen3.5-4B-Q4_K_M.gguf` | **Speed setup.** Fully on the GPU, 24k context, text only |
| `lmstudio-community/gemma-4-26B-A4B-it-QAT-GGUF` | `gemma-4-26B-A4B-it-QAT-Q4_0.gguf` | **Quality setup.** MoE, experts in RAM, 32k context |
| `lmstudio-community/gpt-oss-20b-GGUF` | `gpt-oss-20b-MXFP4.gguf` | Lighter MoE, for when the desktop is busy; 32k context |
| `lmstudio-community/Qwen3.5-9B-GGUF` | `Qwen3.5-9B-Q4_K_M.gguf`, `mmproj-Qwen3.5-9B-BF16.gguf` | Dense 9B with vision; too big for the GPU |
| `lmstudio-community/Llama-3.2-3B-Instruct-GGUF` | `Llama-3.2-3B-Instruct-Q4_K_M.gguf` | Small fallback |
| `Smoffyy/Qwen3.5-4B-Instruct-Revised-GGUF` | `Qwen3.5-4B-Revised-q4_k_m.gguf`, `mmproj-f16.gguf` | Community fine-tune of the 4B, with vision |
| `lmstudio-community/lfm2-24b-a2b-gguf` | `liquid/lfm2-24b-a2b` | Hermes' default. The file name was wrong and **it never downloaded**; only an empty folder exists |

`mmproj-Qwen3.5-4B-BF16.gguf` was downloaded into `disabled-mmproj` on purpose, outside the models tree, so the Qwen3.5 4B loaded text only (see below).

### Installed by hand

These were added from the LM Studio app, not the flake:

- `LiquidAI/LFM2.5-24B-A2B-GGUF` / `LFM2.5-24B-A2B-QAD-Q4_0.gguf`, the working replacement for the broken LFM2 entry above.
- `lmstudio-community/Qwen3.6-27B-GGUF` / `Qwen3.6-27B-Q4_K_M.gguf` (a config file exists for it, but the weights are no longer on disk).

## Global settings

These applied to the CUDA llama.cpp runtime (`llama.cpp-linux-x86_64-nvidia-cuda12-avx2`) for every model.

| Setting | Value | Default | Why |
|---|---|---|---|
| `llm.load.offloadKVCacheToGpu` | `true` | `false` | With the KV cache in system RAM every token crosses PCIe. At 7k tokens of context: **6.8 tok/s** in RAM, **58.7 tok/s** on the GPU |
| `load.gpuStrictVramCap` | `false` | `true` | The cap counts each layer's experts towards VRAM, so it left 6 of the Gemma 26B's 41 layers on the GPU when all 41 belonged there |
| Fallback `llm.load.contextLength` | `8192` | the model's native size | With the strict cap off, a model without its own context asks for its full window (128k on a 3B is 14 GiB of cache) and fails to load |

Local server (`http-server-config.json`): port `1234` on `127.0.0.1`, starts with the app, loads models just in time. The bookmark-sorter extension in TechNet talks to this server and has nothing to talk to now.

## Per-model load settings

### Qwen3.5 4B (speed)

| Setting | Value | Why |
|---|---|---|
| `llm.load.contextLength` | `24576` | Largest that fits next to the weights once the vision projector is gone |
| `llm.load.offloadKVCacheToGpu` | `true` | See above |
| `llm.load.llama.autoFit` | `false` | With auto-fit on, the offload ratio is ignored |
| `llm.load.llama.acceleration.offloadRatio` | `1` | Every layer on the GPU |
| `llm.load.numParallelSessions` | `1` | The default of 4 splits the cache four ways and costs about 600 MiB of VRAM |
| `llm.load.llama.cpuThreadPoolSize` | `6` | One per physical core |

The vision projector (`mmproj`) is always loaded if it sits next to the model, and there is no setting to skip it. For this model it costs 675 MiB of VRAM, the difference between an 8k and a 24k context. Moving the file out of the models tree was the only fix.

### Gemma 4 26B-A4B QAT (quality)

| Setting | Value | Why |
|---|---|---|
| `llm.load.contextLength` | `32768` | |
| `llm.load.offloadKVCacheToGpu` | `true` | |
| `llm.load.llama.autoFit` | `false` | |
| `llm.load.llama.acceleration.offloadRatio` | `1` | All attention layers on the GPU |
| `llm.load.numCpuExpertLayersRatio` | `1` | Every expert in system RAM, which leaves the GPU for attention and the cache |
| `llm.load.numParallelSessions` | `1` | |
| `llm.load.llama.cpuThreadPoolSize` | `6` | The experts run on the CPU, so this sets the speed |
| `llm.load.llama.tryMmap` | `true` | Weights are mapped, so the kernel can drop pages under pressure |
| `llm.load.llama.keepModelInMemory` | `false` | Read in outright, the 14.4 GiB model pushed 12 GiB into zram and halved the speed |

Measured: **18 tok/s** once warm, against 5.5 tok/s on the CPU alone and 8.9 tok/s for the dense 9B half on the GPU. Only 4B parameters are active per token, so the larger model runs faster. The first reply after a load is slow while pages fault in.

### gpt-oss 20B

The same settings as the Gemma 26B, also at 32k context. It runs at nearly the same speed and needs 2.4 GiB less RAM (about 14 GiB free while running, against 8 GiB for the Gemma).

### Other models

| Model | Settings |
|---|---|
| Llama 3.2 3B | The speed setup's settings at 8k context |
| Qwen3.5 9B (`qwen/qwen3.5-9b`) | KV cache on the GPU, 57,118 context, and `llm.prediction.contextOverflowPolicy: rollingWindow` (drops the oldest tokens instead of stopping). The only per-model inference setting found |
| Qwen3.5 4B Revised (Smoffyy) | KV cache on the GPU, `llm.load.useUnifiedKvCache: false`, context 192,332. This was saved from the app and was almost certainly too large to load |
| LFM2.5 24B, Qwen3.6 27B, Qwen3.5 4B / 9B files without a setup | Only the 8k fallback context |

## Thread count

Measured on a MoE model with the experts on the CPU:

| Threads | Speed |
|---|---|
| 4 (LM Studio's default) | 15.2 tok/s |
| 6 (physical cores) | 20.3 tok/s |
| 12 (logical cores) | **1.3 tok/s** |

## Settings that do nothing

The KV cache quantisation fields (`--cache-type-k/v`) are marked experimental in that LM Studio build and are silently dropped. The cache stays f16 whatever is set, so every context size above was budgeted for an f16 cache.

To check what LM Studio actually passed to llama.cpp, read the spawned server's command line: `tr '\0' '\n' < /proc/$(pgrep -f "llama-server --model")/cmdline`.

## Equivalents in llama.cpp and llama-cpp-python

| LM Studio | `llama-server` flag | llama-cpp-python |
|---|---|---|
| `contextLength` | `-c` | `n_ctx` |
| `offloadRatio: 1` | `-ngl 999` | `n_gpu_layers=-1` (`gpu_layers` in `settings.json`) |
| `offloadKVCacheToGpu: true` | default (off is `--no-kv-offload`) | `offload_kqv=True` (default) |
| `cpuThreadPoolSize: 6` | `-t 6` | `n_threads=6` |
| `numParallelSessions: 1` | `--parallel 1` | not applicable, one sequence |
| `numCpuExpertLayersRatio: 1` | `--n-cpu-moe <layers>` or `-ot exps=CPU` | no keyword; see the expert offload section of the model-selection note |
| `tryMmap: true` | default (off is `--no-mmap`) | `use_mmap=True` (default) |
| `keepModelInMemory: false` | no `--mlock` | `use_mlock=False` (default) |
| `autoFit`, `gpuStrictVramCap` | LM Studio only | not applicable |

## Hermes Agent

Hermes ran as a NixOS service on the laptop and used LM Studio's server as its model backend. Settings that were not defaults:

| Setting | Value |
|---|---|
| `model.default` | `lmstudio-community/lfm2-24b-a2b-gguf` (never downloaded, see above) |
| `terminal.backend` | `local` |
| `terminal.timeout` | `180` seconds |
| `memory.enabled` | `true` |
| `container.enable` | `false` (ran on the host, not in a container) |
| `addToSystemPackages` | `true` |
| `stateDir` | `/Storage/Apps/AI/Hermes` |
| `environmentFiles` | the sops secret `hermes_env` from `secrets/3-laptop/hermes.yaml` (deleted with the module) |

An unfinished move to the home-manager module (`programs.hermes-agent` with `desktop.enable`, and `services.hermes-agent` with `backend.mode = "serve"` and `hermesHome`) was in progress and was dropped with the removal. Its state in `/Storage/Apps/AI/Hermes` is still on disk.
