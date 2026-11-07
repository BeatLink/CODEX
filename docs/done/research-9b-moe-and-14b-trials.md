# Qwen3.5-9B, Qwen3.5-35B-A3B and Qwen3-14B trials (2026-11-07)

An overnight trial of three larger models on this machine (Ryzen 5 5600H, 6 cores, 27 GB RAM, RTX 3050 Ti 4 GB), each split between the GPU and the CPU because none fits on the card. Two questions:

- **A.** Does Qwen3.5-9B beat Spark-X2.6-4B under the assessment protocol (doc 3, "Model choice")?
- **B.** Can a bigger model, mostly on the CPU, draft blueprints (doc 2, "Blueprints: deterministic task graphs") for background work? The primary candidate was the mixture-of-experts Qwen3.5-35B-A3B (3B parameters active per token, so only the chosen experts are read for each token); the dense Qwen3-14B was the comparison. The Qwen3.5 family has no 14B.

Build `f0f5cef` for every run, at the 6,144-token context, under the GPU lock with the daemon suspended. Raw output: `evals/results/2026-11-model-trials/` (its README lists the folders). No kernel GPU errors (`journalctl -k`) in any run.

## Files

| Model | File | Size | Blocks | Source |
|---|---|---|---|---|
| Qwen3.5-9B | `Qwen_Qwen3.5-9B-Q4_K_M.gguf` | 6,169,341,984 B | 33 | `bartowski/Qwen_Qwen3.5-9B-GGUF` |
| Qwen3.5-35B-A3B | `Qwen3.5-35B-A3B-UD-IQ3_S.gguf` | 13,583,383,168 B | 40 (256 experts, 8 used) | `unsloth/Qwen3.5-35B-A3B-GGUF` |
| Qwen3-14B | `Qwen_Qwen3-14B-Q4_K_M.gguf` | 9,001,753,632 B | 40 | `bartowski/Qwen_Qwen3-14B-GGUF` |

Sizes matched the Hugging Face listing; the 9B and 14B SHA-256 matched the LFS hashes. The MoE quant was chosen against RAM: the largest Unsloth dynamic quant at most 16 GB is UD-IQ3_S (UD-Q3_K_XL is 16.6 GB), and the file had to be at most the `available` memory less 4 GB, so the page cache does not evict experts between calls. With the desktop running, `available` was 15,720–17,305 MiB over the night; the file (12,954 MiB) passed the rule only once nothing else was loaded (17,305 MiB at 08:47, with the daemon suspended). UD-IQ2_M (11.4 GB) was also fetched as a fallback and not used. All files are in `models/` (gitignored); `models/model.gguf` still points at Spark.

## GPU layers

llama.cpp fails to create the context (a 505–533 MiB compute buffer) when the weights leave too little VRAM. The embedding model loads on the CPU (`core/embeddings.ts` passes 0 layers), so it takes no VRAM.

| Model | Layers on the GPU | Peak VRAM | Peak RSS | Higher count |
|---|---|---|---|---|
| Qwen3.5-9B | **17 of 33** | 3,638–3,717 MiB | 5.1–6.5 GiB | 18 and 20 fail to create the context |
| Qwen3.5-35B-A3B | **9 of 40** | 3,516 MiB | 11.1–13.0 GiB | 10 fails to create the context |
| Qwen3-14B | **12 of 40** | 3,448 MiB | 8.9 GiB | not tried |

## A. Qwen3.5-9B under the assessment protocol

Three rounds of each set, 17 layers on the GPU. Time per set: agents 40.5 min, reasoning 64.1 min, scaled 2 h 47 min (the scaled set ran because the first two finished at 05:59, before the 06:00 cut-off).

| Set | Runner | Tasks passed | pass^k | Per round | Runs reaching an MCP tool | Model calls | s per call | Tool calls (valid / failed) | Tool choice |
|---|---|---|---|---|---|---|---|---|---|
| agents | tree | 19/24 (79%) | 6/8 | 6 6 7 | 24/24 | 167 | 7.0 | 27 / 0 | 18/24 (75%) |
| agents | agents | 19/24 (79%) | 6/8 | 6 6 7 | 24/24 | 176 | 7.1 | 28 / 0 | 19/24 (79%) |
| reasoning | bare | 63/75 (84%) | 21/25 | 21 21 21 | – | 75 | 13.5 | – | – |
| reasoning | tree | 74/75 (99%) | 24/25 | 25 25 24 | – | 326 | 8.6 | 2 / 0 | – |
| scaled | tree | 0/66 (0%) | 0/22 | 0 0 0 | 31/66 | 477 | 8.9 | 58 / 0 | 3/66 (5%) |
| scaled | agents | 21/66 (32%) | 6/22 | 7 7 7 | 56/66 | 697 | 8.3 | 85 / 1 | 22/66 (33%) |

`Tool calls arrived as text` appeared 0 times in all three logs, so every call parsed natively through `QwenChatWrapper`.

**Against Spark.** The Spark rows that share a build are the scaled ones (`f0f5cef`, doc 3); the agents baseline with an `--output` file is `agents/spark-full.json` on the older `c702aa7`, and the reasoning baseline `reasoning/spark-reasoning.json` is on `bbac823`, so those two comparisons also carry build changes. `--compare spark-full.json --against qwen9b-agents.json`:

- **agents set:** `tree` 19/24 → 19/24 (pass^k 5/8 → 6/8); `agents` 17/24 → 19/24 (5/8 → 6/8). Better: `garage-code` and `marcus-phone` (0–1/3 → 3/3 on both runners). Worse: `priya-last-email` (3/3 → 0/3 on `agents`, 1/3 on `tree`) and `free-slot-and-weather` (2/3 → 0/3 on `tree`, 1/3 on `agents`). Spark's newest agents rows (`cd98067`, raw file not kept) are `agents` 24/24 (pass^k 8/8) and `tree` 19/24 (pass^k 4/8), so against those the 9B ties `tree` on the pooled rate and loses `agents` by five.
- **The 9B never takes the second hop.** Every failed run on the agents set called one tool (`find_contact` or `find_free_time`) and then answered that it "could not verify" the rest, e.g. "Priya Raman's email address is priya.raman@example.org. I could not verify her latest email to you." The scaled set shows the same: `agents` passed 20/21 one-server runs, 0/21 two-server runs and 1/24 runs needing three or more, against Spark's 21/21, 18/21 and 15/24.
- **scaled set, same build:** `agents` 21/66 (pass^k 6/22) against Spark's 54/66 (18/22); tool choice 33% against 91%. `tree` 0/66 for both, but 24 of the 9B's 66 `tree` runs errored with node-llama-cpp's "The default context shift strategy did not return a history that fits the context size", which Spark's run did not report: the 116 tool definitions do not fit the 6,144-token window with the Qwen3.5 template (doc 2, "A flat tool list larger than the context").
- **reasoning set:** `bare` 59/75 → 63/75 (pass^k 19/25 → 21/25), `tree` 70/75 → 74/75 (22/25 → 24/25). Better: `number-rhyming-with-tree` (bare and tree), `boiling-eggs`, `order-of-operations` (tree), `outer-planets-mission`, `voyager-1-speed` (bare). Worse: `clock-angle-3-15` on `bare` (3/3 → 0/3) and `country-ending-in-lia` on `tree` (3/3 → 2/3). Two of the 9B's four `bare` failures are its checks, not its answers: it wrote `$7.5^\circ$` for the clock angle (the check wants `7.5°`) and a "(2)" in its letter count of "strawberry" after answering 3. Its real `bare` errors are "Mali" for a country ending in "lia" and no figure for Voyager 2's speed.
- **Speed:** 7.0–8.9 s per call on the tool sets and 13.5 on `bare` reasoning, against Spark's 1.5–2.7 and 6.8: about 3.5–4.5 times slower per call. A three-round agents set takes 40 minutes against Spark's 12.

**Protocol verdict: a trade-off, not a switch.** The 9B is better at reasoning (+4 tasks on each runner, pass^k +2 on each) and steadier where Spark was flaky on one-hop lookups, but it does not win tool use in every round: it ties Spark's newest `tree` row, loses its newest `agents` row by five tasks, and loses the scaled `agents` set 21 to 54 on the same build, because it stops after the first agent. It is also about four times slower per call with half its layers on the CPU. Whether to switch is the user's decision; on these figures the protocol does not support it.

## B. Blueprint drafting

### The prompt

The system prompt (`blueprints/prompts/bare-system.txt`, about 350 words, passed with `--prompts`) explains a blueprint as a deterministic task graph the harness runs, with the model filling one narrow slot per call, written as one JSON object with eight step kinds: `list`, `batch`, `loop_over_items`, `classify` (a fixed enum), `lookup_via_agent` (agents `files`, `mail`, `calendar`, `contacts`, `notes`, `todos`), `write`, `check_coverage` (a code check) and `ask_user`. Each step names its `inputs` and `output`. It asks for strict JSON and says to prefer code to the model and add a coverage check wherever one is possible. The four requests (`blueprints/blueprint_tasks.json`): (1) sort every file under a folder tree into five categories with nothing missed; (2) process the morning inbox: triage, draft replies where needed, notify for the rest; (3) find a free one-hour slot next week for two named people and propose it; (4) a weekly review of to-dos due, meetings and unanswered mail as one report. `bare` runner, one round, `max_tokens` 3,072, no grammar, so JSON validity is the model's own.

### Tuning the MoE first

Every setting node-llama-cpp 3.22 exposes was tried one at a time on the free-slot request, two calls per setting. tok/s is completion tokens over wall time and includes reading the ~750-token prompt; output length varies by setting, so differences under ~6% are noise. `src/core/model.ts` passes only `gpuLayers` and `contextSize` today, so each setting was set by a scratch patch that read environment variables; the patch was not committed.

| Setting | Value | GPU layers | tok/s | s per call | Peak VRAM | Peak RSS |
|---|---|---|---|---|---|---|
| defaults (6 threads, flash attention off, F16 KV, batch 512, mmap) | – | 4 | 12.0 | 50.6 | 1,972 MiB | 12.6 GiB |
| threads | 6 (the physical cores; the same as the default) | 4 | 12.1 | 53.6 | 1,972 MiB | 12.8 GiB |
| threads | 12 (with hyper-threads) | 4 | first call 153 s, second over 25 min; stopped | – | 1,972 MiB | 12.5 GiB |
| flash attention | on | 4 | 10.2 | 74.6 | 1,972 MiB | 12.5 GiB |
| flash attention + KV cache | on, q8_0 / q8_0 | 4 | 10.1 | 59.7 | 1,968 MiB | 12.5 GiB |
| GPU layers | 8 | 8 | 11.7 | 57.4 | 3,208 MiB | 11.4 GiB |
| GPU layers | 9 | 9 | 12.1 | 63.9 | 3,516 MiB | 11.1 GiB |
| GPU layers | 10 | 10 | context not created (505 MiB buffer) | – | – | – |
| batch size | 256 | 9 | 11.5 | 49.9 | 3,324 MiB | 11.1 GiB |
| batch size | 1,024 | 8 | 12.7 | 60.0 | 3,716 MiB | 11.5 GiB |
| mlock | on | 9 | 12.4 | 43.1 | 3,536 MiB | 10.7 GiB |
| experts on the CPU, attention and KV on the GPU | – | – | not reachable | – | – | – |

- **Threads:** the default is already the 6 physical cores. 12 threads made generation many times slower (the hyper-threads contend for the same cores), so never set it above 6.
- **Flash attention** cost about 15% here, with or without a q8_0 KV cache: most attention runs on the CPU at 4–9 GPU layers. The KV cache freed nothing measurable because most Qwen3.5 blocks are linear-attention blocks with a small fixed state rather than a KV cache, so it gave no room for more layers.
- **GPU layers** move about 3% of the weights per layer and changed nothing measurable between 4 and 9; 9 is the most that fits.
- **Batch size** changes only prompt reading; 256, 512 and 1,024 were within noise on a 750-token prompt.
- **mlock** asks to lock the 13.6 GB in RAM, but `ulimit -l` is 4 GiB here, so only part was locked, with no measurable gain.
- **Experts on the CPU** (llama.cpp's tensor buffer overrides, `--override-tensor` / `--n-cpu-moe`) are not reachable: node-llama-cpp 3.22's model options have no tensor placement and its native addon sets no `tensor_buft_overrides`. Reaching it means changing node-llama-cpp itself, not a setting.

**Best combination:** 9 GPU layers and every other setting at its default. None of the reachable settings beyond `gpu_layers` (already a setting) changed speed enough to be worth exposing, so no code change was made. RAM while loaded: 11–13 GiB resident (the mapped file), out of 17,305 MiB available before the load.

### Speed per answer

| Model | GPU layers | Seconds per answer (four requests) | tok/s |
|---|---|---|---|
| Qwen3.5-35B-A3B UD-IQ3_S | 9 of 40 | 30, 43, 60, 38 (mean 43) | 11.7–14.0 |
| Qwen3.5-9B Q4_K_M | 17 of 33 | 38, 31, 35, 44 (mean 37) | 10.2–10.5 |
| Qwen3-14B Q4_K_M | 12 of 40 | 51, 65, 68, 78 (mean 66) | 5.1–5.4 |
| Spark-X2.6-4B Q4_K_M | all | 10, 12, 9, 8 (mean 10) | 42–48 |

The MoE generates faster than the dense 9B with half the 9B's layers on the GPU, and more than twice as fast as the dense 14B, as the 3B active parameters predict. Its answers were longer, so its seconds per answer are similar to the 9B's.

### Verdicts

Judged on: valid JSON; only the eight kinds; loops owned by the harness; a code check wherever one is possible; sensible inputs and outputs; no invented tools, agents or sources.

| Request | Qwen3.5-35B-A3B | Qwen3.5-9B | Qwen3-14B | Spark-X2.6-4B |
|---|---|---|---|---|
| 1. Folder categories | **good**: list, batch, loop, classify with the five categories, coverage check; omits per-step `inputs`/`output` and has the model write the whole report | **good**: the same, with the coverage check on the classifier's output, the right place | **invalid JSON**; stops after classifying: no report, no coverage check | **invalid JSON** (one brace too many); otherwise the best: every step names its inputs and output, coverage check compares the listing with the classified files |
| 2. Morning inbox | **usable with edits**: classify per message, final check that every message lands in replies or the notification; misuses `check_coverage` as a filter inside loops | **poor**: drafts a reply for every message whatever the class, a `write` step to "store" the reply, and notifies through `ask_user` offering to delete or archive mail | **poor**: one `classify` over the whole list (no loop), invented agent `notifications`, no coverage check | **invalid JSON**; content fair: per-message classify and coverage check, but drafts in a loop over every message |
| 3. Free slot for two people | **poor**: candidate slots from an invented "system" calendar, overlap done by misused `check_coverage` steps, and it sends the proposal through `lookup_via_agent` with no `ask_user` | **poor**: asks the model to classify each slot "free for both", a comparison code should do; a `batch` with no input | **usable with edits**: both calendars through the `calendar` agent, every step names inputs and output, the overlap as one code step (mislabelled `check_coverage`), proposes rather than sends | **poor**: invented sources `schedules` and `free_slots`, the overlap hidden in a list filter, a meaningless coverage rule |
| 4. Weekly review | **usable with edits**: three lists, a report, a coverage check over all three; adds unrequested priority and urgency classes without a loop | **usable with edits**: the same, with one `batch` over three lists that have no common input | **invalid JSON**; batches nested inside a loop over the three lists | **good**: three lists, one report, a coverage check over all three; source `meetings` instead of `calendar` |
| Valid JSON | 4/4 | 4/4 | 2/4 | 2/4 |

### Excerpts

All names are the prompts' fictional ones.

- **Qwen3.5-35B-A3B, good** (folder): `{"id": "s6", "kind": "check_coverage", "rule": "Every file from input s1 must appear exactly once in the output of s5 grouped by category."}`
- **Qwen3.5-35B-A3B, bad** (free slot, acting without approval through a lookup): `{"id": "send_to_dana", "kind": "lookup_via_agent", "agent": "mail", "find": "send to Dana Reyes with subject 'Meeting Proposal'"}`
- **Qwen3.5-9B, good** (folder): `{"id": "check_coverage", "kind": "check_coverage", "rule": "Every file in fetch_files must appear exactly once in the output of classify_files."}`
- **Qwen3.5-9B, bad** (free slot, the model asked to do a comparison): `{"id": "step_5", "kind": "classify", "enum": ["free", "busy"], "question": "Is this one-hour slot free for both Dana Reyes and Sam Okafor?"}`
- **Qwen3-14B, good** (inbox, routing by the enum in code): `{"id": "filter_needs_reply", "kind": "list", "inputs": ["new_messages", "classify_messages"], "filter": "needs_reply", "output": "messages_needing_reply"}`
- **Qwen3-14B, bad** (inbox, an agent that does not exist): `{"id": "notify_user", "kind": "lookup_via_agent", "agent": "notifications", "find": "send notification with content"}`
- **Spark-X2.6-4B, good** (weekly review): `"rule": "every item in todos_this_week, meetings_this_week, and unanswered_mail appears in weekly_review_report exactly once"`
- **Spark-X2.6-4B, bad** (free slot, an invented source doing the work): `{"id": "free_slots", "kind": "list", "source": "free_slots", "filter": "owner: Dana Reyes and owner: Sam Okafor and duration: 1 hour and free: true and date: next_week"}`

### What the blueprints show

- **No model wrote four blueprints that would run unedited.** The best per request were the MoE and 9B on the folder, the MoE on the inbox, the 14B on the free slot, and Spark and the MoE on the weekly review. Every model got the folder shape roughly right; the free slot, which needs a set intersection, was poor from three of four.
- **The common mistakes come from the vocabulary, not only the models.** With no `filter`, `select` or `compare` kind, all four models used `check_coverage` (or `list`, or `classify`) to filter, intersect or pick. A real vocabulary needs those as code kinds, and a validator should reject a `check_coverage` whose rule is not a check.
- **Acting without approval:** the MoE sent mail from a lookup step, and two models invented notification channels. A validator can refuse any step with a side effect that is not behind `ask_user`.
- **JSON validity does not separate the models:** the 4B and 14B broke 2 of 4 by a bracket, but the harness would ask with a JSON schema, and node-llama-cpp then forces valid JSON by grammar (doc 1, "Shared machinery").
- **Speed:** Spark answers in about 10 s; the 9B and MoE in 30–60 s; the 14B in about a minute at 5 tok/s.

**Conclusions.** A dense 14B on the CPU is not worth it for background blueprint proposals: the slowest, with no quality gain over the 9B or the MoE (two invalid answers, one truncated, one invented agent). The 9B already drafts about as well as the MoE on three of four requests. The MoE adds speed (12–14 tok/s, faster than the partly offloaded 9B), the most coverage checks, and the only inbox blueprint with a correct end check, at the cost of 11–13 GiB of RAM while loaded, too much to keep resident beside the desktop. A bigger model adds completeness, not correctness: every model's blueprints need a human or a validator. So doc 2's rule stands: a model-written blueprint is a proposal the user approves, checked first by a deterministic validator (only known kinds, agents and sources; every input names an earlier output; a code check present where the shape allows; side effects only behind `ask_user`). Spark's quality on the folder and weekly requests suggests even the 4B can draft simple blueprints for that pipeline.

## Not done

- **The one-round agents run on the MoE** was to run only if the blueprint work finished before 05:00; it finished at 09:44, so there is no tool-use or seconds-per-call figure for the MoE through the harness yet.
- **Higher GPU layer counts for the 14B** were not tried; 12 fitted at 3,448 MiB.
- **Spark's `cd98067` agents rows and the 9B's are not on one build**, and Spark has no raw file for them; a paired comparison on the same build needs a Spark agents run on `f0f5cef` or later.
