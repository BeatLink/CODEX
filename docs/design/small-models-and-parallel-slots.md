# Model size, draft models, and parallel slots

This note covers how to get the most out of one GPU: whether to run one larger model or several
smaller ones, and where a small model or parallel slots still help.

## Recommendation

Load the largest model that still fits with a useful context, run the stage chain sequentially, and
add a small draft model for speculative decoding when speed becomes the bottleneck. Only use
parallel slots for the independent side jobs, never for the main stage chain.

## Why one larger model beats several small ones

- **The pipeline is a chain.** Each stage reads the results of the stages before it, and the daemon
  runs one request at a time behind a single model lock. A request has almost nothing to run in
  parallel, so extra models would mostly sit idle.
- **Token generation is limited by memory bandwidth.** Each generated token reads every weight once.
  Two models on one GPU share that bandwidth, so each runs at roughly half speed and the total
  barely changes. On an integrated GPU using system RAM the bandwidth is even lower.
- **Each model costs memory twice.** It needs its own weights and its own KV cache, which leaves
  less room for context. Every stage carries evidence, so context is the scarcer resource.
- **Judgment is the weak link.** The review and critique stages only help when the model can spot
  the mistakes, and a 4B model checking its own output catches far fewer than an 8B to 14B model
  would. A larger model improves answer quality more than any amount of parallelism.

Choose the model size first, then let Auto size pick the context and reply limits for it. A Q4_K_M
quantization is a good balance of size and quality.

## Draft model for speculative decoding

A small draft model from the same family (for example Qwen3.5-0.5B beside a larger Qwen3.5)
proposes several tokens ahead, and the main model checks them all in one forward pass. Accepted
tokens cost one pass instead of several, so output is often 1.5 to 2.5 times faster with no change
in quality, because the main model still decides every token.

- The two models must share a tokenizer, so they should come from the same family.
- The draft model adds its own weights and a small KV cache, so Auto size has to count it.
- `llama-server` takes a draft model with `-md`. In `llama-cpp-python`, the `draft_model` argument
  of `Llama` takes a `LlamaDraftModel` object, and the only built-in one is
  `LlamaPromptLookupDecoding`, which drafts by copying text from the prompt instead of running a
  second model. A real draft model in-process needs a custom `LlamaDraftModel` subclass.
- Prompt lookup costs no memory and suits stages that quote their input, such as revise and
  summaries, so it is the cheapest first step in the current in-process loading in `pipeline.py`.

Possible settings: `draft_model_path` (empty means off) and `draft_tokens` (how many tokens to
propose per step).

## Parallel slots

### How they work

One loaded model serves several sequences at once.

- The weights are loaded once and every slot shares them.
- Each slot has its own KV cache, the attention memory for the tokens that sequence has seen.
- On each decoding step, llama.cpp puts the next token of every active slot into one batch and runs
  a single forward pass. Reading the weights is the slow part, and it now happens once per step for
  all slots, so four slots give close to four times the total tokens per second while each one runs
  only a little slower than it would alone. This holds until compute becomes the limit, which comes
  sooner on an integrated GPU than on a discrete one.

### KV cache cost

The KV cache grows with the total number of tokens held across all slots.

- In `llama-server`, `-c` is the total context and `-np` splits it between slots: `-c 8192 -np 4`
  gives each slot 2048 tokens and uses the same KV memory as one 8192-token context.
- Four slots of 4096 tokens each need `-c 16384`, four times the KV memory of one 4096-token slot.
- `--kv-unified` lets the slots share one pool instead of fixed shares, which helps when one job is
  long and the others are short.
- KV memory is roughly 2 × attention layers × KV heads × head size × bytes per value × total tokens,
  which is what `auto_size.py` already computes per token. Quantizing the cache with
  `--cache-type-k q8_0 --cache-type-v q8_0` about halves it.

### Where they would help

The high-level `Llama` class in `llama-cpp-python` runs one sequence at a time, so slots mean
running `llama-server -np N` and calling its OpenAI-compatible HTTP API instead of loading the model
inside the daemon. That is only worth doing for work whose calls do not depend on each other:

- summarizing the chunks of a fetched page;
- extracting facts from each source during background research;
- background research running beside a foreground request, instead of waiting for the model lock.

The stage chain would still use one slot at a time. Slots split the context, so a request's slot
would get less context than it does now unless the total grows to match.

## Suggested order

1. Move to a larger model and re-run Auto size.
2. Turn on prompt lookup decoding; add a real draft model, counted in Auto size, once the model runs
   under `llama-server`.
3. Only if side jobs are still slow, move model loading to `llama-server` with a few slots, giving
   the foreground request one full-size slot and sharing the rest among side jobs.
