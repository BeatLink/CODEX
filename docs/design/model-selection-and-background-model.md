# Model selection and a stronger background model

Status report, written 2026-10-20. Covers which model SmartHarness runs on this laptop, what was changed, what is still unverified, and a design for running a larger model only for background research. See also [small-models-and-parallel-slots.md](small-models-and-parallel-slots.md) for draft models and parallel slots.

## Hardware

| Part | Detail |
|---|---|
| GPU | NVIDIA RTX 3050 Ti Mobile, 4 GB VRAM, about 190 GB/s; the display runs on the AMD iGPU, so the NVIDIA card is free for models |
| CPU | AMD Ryzen 5 5600H, 6 cores / 12 threads |
| RAM | 27 GiB DDR4, about 40 GB/s in practice; roughly 8–12 GiB was available during this work |
| Disk | `/Storage` is ZFS; ZFS ARC is capped at 4 GiB but was seen at 5 GiB |
| Runtime | llama-cpp-python 0.3.36 with CUDA, from `flake.nix` |

`nvidia-smi` segfaults on this machine, so `auto_size.free_gpu_bytes()` may not be able to read free VRAM. To see which processes hold the GPU, look for `nvidia-uvm` in `/proc/<pid>/fd`.

## Model files

All files live in `models/`, which is gitignored. `settings.json` still points at `./models/model.gguf`, and `model.gguf` is now a symlink.

| File | Size | Role |
|---|---|---|
| `model.gguf` → `Qwen3.5-4B-UD-Q4_K_XL.gguf` | 2.91 GB | Active foreground model, **not yet verified on the GPU** |
| `Qwen3.5-4B-Q3_K_M.gguf` | 2.29 GB | Previous model, kept so we can switch back |
| `Qwen3.5-35B-A3B-UD-IQ4_XS.gguf` | 17.49 GB | Downloaded as the stronger alternate; never loaded yet |

All three come from Unsloth's Hugging Face repos (`unsloth/Qwen3.5-4B-GGUF`, `unsloth/Qwen3.5-35B-A3B-GGUF`) and use imatrix quantization.

Other quants of the same models, for reference:

- **4B:** IQ4_XS is 2.48 GB, Q4_K_M 2.74 GB, Q5_K_M 3.14 GB.
- **35B-A3B:** UD-Q2_K_XL is 12.16 GB, UD-Q3_K_XL 16.60 GB, Q4_K_M 22.02 GB.
- **9B:** Q4_K_M is 5.68 GB, and even IQ2_XXS is 3.19 GB. No sensible 9B quant fits in 4 GB of VRAM, so the 9B was ruled out.

## Why the quant changed

For a fixed memory budget, a larger model at about 4 bits usually beats a smaller model at higher precision. Below about 3 bits, quality falls steeply, and small models suffer most. A 4B at Q3 is on the wrong side of that line, and structured JSON output, which this pipeline relies on, is among the first things to degrade. Qwen3.5 uses full attention on only every 4th layer, so its context cache is small and the larger 4B quant still fits on the GPU.

## Open problem: context size with the new 4B file

`settings.json` on main has `context_size: 15360`, `max_tokens: 3840` and `background_max_tokens: 1920`. Those were sized for the old Q3 file. The Q4_K_XL file is about 600 MB larger, so 15,360 tokens probably no longer fits in 4 GB.

- `auto_size.choose_sizes` with 3.8 GiB of free VRAM gives **12,288** tokens for Q3_K_M but only **3,072** for UD-Q4_K_XL. Its rule is cautious: 10% headroom, a 512 MiB reserve, and 64 KiB per token, which includes batch scratch.
- A rough estimate from real buffer sizes puts the actual limit near **8k**. This is unmeasured.
- The first load test failed with `unable to allocate CUDA0 buffer`, because another session's smoke-test daemon was holding the GPU at the time. That test proves nothing either way.

**Decision pending.** Either keep UD-Q4_K_XL and lower the context to whatever fits, or switch to IQ4_XS (2.48 GB). IQ4_XS is 4-bit quality at close to Q3 size and should keep about 12k of context.

**Next step:** when no other process holds `nvidia-uvm`, load each candidate with `n_gpu_layers=-1` at several `n_ctx` values. Record the largest context that loads, and the generation speed in tokens per second.

## Expected speeds

These are estimates from memory bandwidth, not measurements.

| Setup | Generation | Prompt reading |
|---|---|---|
| 4B Q4, fully on the GPU | ~35–50 tok/s | ~1,000+ tok/s |
| 35B-A3B, experts in RAM, rest on the GPU | ~10–15 tok/s | ~100–300 tok/s |
| 35B-A3B using only `n_gpu_layers` | ~7–12 tok/s | ~50–150 tok/s |
| 35B-A3B on the CPU only | ~8–12 tok/s | ~30–60 tok/s |
| Any 35B setup without enough free RAM | 1–3 tok/s or worse | crawls |

The MoE model is capped by DDR4. Each token still reads 1.5–2 GB of expert weights from RAM.

## Experts in RAM: what llama-cpp-python supports

"Experts in RAM, rest on the GPU" is llama.cpp's `-ot` / `--n-cpu-moe` feature. In llama-cpp-python 0.3.36:

- `Llama.__init__` has no keyword argument for it. The only related ones are `tensor_split` and `kv_overrides`.
- The low-level `llama_model_params` struct does have a `tensor_buft_overrides` field.
- No binding returns the CPU buffer type. Using the field would mean loading `ggml_backend_dev_buffer_type` / the CPU device from the bundled libggml through ctypes, then patching the model params before `Llama` builds the model. This is a small hack, but a fragile one.
- The cleaner alternative is to run llama.cpp's `llama-server` as a separate process with `--n-cpu-moe`, and call it over HTTP.

This only matters if the 35B were the foreground model. For background use, see below.

## RAM use (snapshot)

| Using it | Amount |
|---|---|
| ZFS ARC | ~5 GiB |
| VSCodium | ~3 GiB |
| Firefox | ~3.4 GiB |
| `attic watch-store technet` | ~3 GiB |
| Kernel memory that can't be freed (mostly ZFS) | ~2.9 GiB |
| Claude sessions | ~2.3 GiB |
| A SmartHarness smoke-test daemon | ~1.5 GiB |

`attic-watch-store.service` is crash-looping. The Attic server on heimdall (`attic.heimdall.technet`) answers uploads with 504 and 500 errors. The client queues every failed upload in memory until it reaches about 3 GB, then panics with `watch_store.rs:116 ... sending into a closed channel`, and systemd restarts it. That happened 6 times in 24 hours. The fix is on the server side and is not part of this repo.

The 35B model needs about 17.5 GB of RAM on the CPU, or 12–16 GB with the Q2 or Q3 files. That is only realistic once Attic is fixed and a few apps are closed. Weights are mmapped, so a shortage does not crash anything; the kernel drops pages and rereads them from disk, which makes generation crawl.

## How models are loaded today

- `pipeline.create_model(model_path, context_size, gpu_layers)` builds a `Llama`.
- `pipeline.ModelCache` holds **one** model, keyed by `(path, context, gpu_layers)`, and reloads it only when that key changes. It drops the old model before loading the new one.
- The daemon (`daemon.py`) owns a single `ModelCache` and a `_model_lock`. Foreground runs and `_background_loop` share both.
- `background._BackgroundModel` takes the lock for each call. Its token callback calls `check_pause()`, which raises `_BackgroundPaused` as soon as a foreground run starts. A foreground request therefore waits for at most a fraction of one background call.
- The background loop runs `research_one_topic`, falling back to `learn_from_episodes`. `_refresh_parent_summary` rewrites parent topic summaries.

## Design: a separate background model

**Goal:** the foreground stays fast on the 4B. Background research (fact extraction, episode learning, topic summaries, and a new tree-reorganisation job) uses the 35B-A3B.

**Why not just reuse the current cache.** With one cache, every foreground prompt would unload the 35B (about 17 GB), load the 4B, and later reload the 35B. That churn costs tens of seconds each time. The 4B and the 35B also cannot share the 4 GB GPU.

**Proposal:**

1. **Settings.** Add `background_model_path` (empty means use `model_path`), `background_gpu_layers` (default 0) and `background_context_size` (empty means use `context_size`). Validate them in `settings.py`, and expose them in the CLI, TUI and GTK option pages next to the existing model fields.
2. **Two caches.** The daemon keeps a second `ModelCache` and its own lock for the background model. `_BackgroundModel._load` reads the `background_*` settings. When the background model differs from the foreground one, background calls no longer take the foreground lock. When they are the same file, keep today's shared cache and lock.
3. **Placement.** Keep the 4B fully on the GPU. Run the 35B on the CPU only (`background_gpu_layers: 0`), so neither evicts the other. Expert offload is not needed in this role.
4. **Preemption.** Keep `check_pause()` as it is. It already stops background generation as soon as a foreground run starts, which also frees the CPU for the foreground's prompt handling.
5. **Unloading when idle.** After the background worker finds no work for a while, drop the 35B (set the cache's model to None) and give its RAM back. Reload it on the next job.
6. **Auto size.** `auto_size` should size the background model against free RAM, since it runs with `gpu_layers` 0, separately from the foreground model's GPU sizing.
7. **Throughput.** On the CPU, a per-source call with about 3k tokens of input takes roughly a minute. Background work will get through 5–10× fewer items, each done better. Keep `background_max_tokens` modest.
8. **Tree reorganisation (new job).** When queued research and episode learning are both empty, have the background model propose topic merges, renames and re-parenting, using the knowledge tree's `graph()` and `topics()`. Apply them through `KnowledgeStore` and broadcast `knowledge.changed`. The larger model is far better at whole-tree reasoning than the 4B.

**Tests.** Settings validation for the new keys. Background loading uses the `background_*` settings. Two caches don't share a lock when the paths differ. The idle unload releases the model. Use a fake model factory, as the existing tests do.

## Decisions waiting on the user

1. Keep 4B UD-Q4_K_XL at a smaller context (measure it first), or switch to IQ4_XS and keep about 12k.
2. Build the separate background model as designed above.
3. Investigate the Attic server on heimdall. This is outside this repo.
