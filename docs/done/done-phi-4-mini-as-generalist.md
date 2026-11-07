# Phi-4-mini as the generalist: rejected

Phi-4-mini-instruct and Phi-3.5-mini-instruct (Microsoft, 3.8B, MIT) were reviewed as replacements for Qwen3.5-4B, beside Spark-X2.6-4B (doc 2, "Alternative models"). Both were dropped on 2026-11-06, before the assessment protocol, because neither can do the job on this hardware and harness. Phi-4-mini-reasoning, the reasoning specialist in doc 2, is a different model and stays open.

## Desk review

- **Claims going in** (from memory, unchecked): both take a 128K context and are known for math and reasoning for their size rather than knowledge or instruction following; Phi-4-mini (2025-02) supersedes Phi-3.5-mini (2024-08) and adds function calling, Phi-3.5-mini has none. Their Q4_K_M files are ~2.4–2.5 GB, so headroom on the 4 GB GPU looked like their advantage.
- **Phi-3.5-mini dropped on memory:** its published config has 32 KV heads (head size 96), ~384 KiB of KV cache per token at F16, 2.25 GiB at 6,144 tokens. With its weights that does not fit the 4 GB GPU without KV quantization or a much shorter context.
- **Phi-4-mini fits, barely:** its config and the GGUF (unsloth `Phi-4-mini-instruct-Q4_K_M.gguf`, 2.49 GB, hash checked against the repo) agree: architecture `phi3`, 32 blocks, 24 heads, 8 KV heads, 200,064-token vocabulary. node-llama-cpp's estimator gave 3,852 MiB for all layers at 6,144 tokens, more than the card's 3,773. Measured on CUDA it uses 3,663 MiB with all 33 layers (56.8 tok/s on a 120-token reply) and 3,319 MiB with 29 (39.2 tok/s), with no GPU errors. That leaves ~110 MiB spare, less than Qwen3.5-4B's ~146 MiB, so it brings no headroom despite the smaller file: the large vocabulary costs what the weights save.
- **Outside figures:** the Artificial Analysis Intelligence Index v4.1 lists Phi-4-mini at 6 (marked as an estimate) against 16 for Qwen3.5-4B without reasoning and 20 with it. No official BFCL entry was found for either. One community tool-calling test (40 cases, not BFCL) scored Phi-4-mini 57.5% and Qwen3.5-4B 97.5%.

## Tool-call format

node-llama-cpp has no chat wrapper for Phi-4-mini and falls back to the generic Jinja wrapper, which teaches its own `||call: name(params)` syntax. Phi wrote `call: mcp__mail__list_inbox({"limit": 1})`, without the `||`, so no call was read: the first smoke run failed `tree` in 15 s and looped on `agents` for 18 minutes until stopped.

Phi's own format, from its vocabulary and model card: tools as JSON inside `<|tool|>…<|/tool|>` in the system message, calls as `<|tool_call|>[{"name": …, "arguments": …}]<|/tool_call|>`, results after `<|tool_response|>`. Commit `8c51174` gives a model whose template has the `<|tool|>` block that format (doc 1, "Tools"). On the CPU, Phi then made a real `list_inbox` call and answered correctly from its result.

## Smoke run with the format fixed

`--only inbox-newest`, `--runners tree,agents`, build `58d7927`, all layers on the GPU, `--stream` on:

- **`tree`: failed (0/2) in 98 s.** It now made real tool calls, but the wrong ones: `list_directory` and `read_file` on a mail file it made up (`.config/mail/dummy-email.txt/newest_email.txt`), never the mail server's `list_inbox`.
- **`agents`: no tool calls at all in 12 minutes**, stopped by hand. Each task decided, wrote an answer without data, failed its check, revised, failed again and was split, down to `Task 1.2.2.1`: about 135 steps over 14 tasks (37 checks, 19 revisions, 17 decisions, 14 routing calls, 5 splits).

Spark-X2.6-4B and Qwen3.5-4B pass this task on both runners in 10–30 s.

## Verdict

Rejected as the generalist. With the call syntax fixed, Phi-4-mini still fails the step the harness depends on most: choosing the right tool or agent. It has no memory advantage over Qwen3.5-4B to trade against that, and the outside figures point the same way. The 48-run assessment would have measured the same loop for an hour or more. Revisit only if a later Phi model ships with stronger tool use; the format support in `core/model.ts` stays for any Phi model, including Phi-4-mini-reasoning.
