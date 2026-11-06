# Is a 4B model good enough to be the CODEX assistant?

Assessment of Qwen3.5-4B inside the CODEX harness, from published benchmarks. Gathered 2026-11-05. The CODEX eval results were not read for this assessment.

## Verdict

Yes, if the harness does most of the work. A 4B model handles narrow, well-specified jobs. It is not good enough as an autonomous agent that plans and recovers on its own. CODEX is built around the first approach, so it is a reasonable bet.

## What the research says

| Evidence | Result | Reading |
| --- | --- | --- |
| BFCL, Qwen3-4B (prompt mode), [TinyLLM](https://arxiv.org/pdf/2511.22138) | about 62% overall, 83% non-live, 75% live | single-turn is fine |
| Same study, multi-turn | about 35% | weak |
| BFCL-V4, Qwen3-4B-Instruct-2507, [benchmarklist](https://benchmarklist.com/models/qwen3-4b-instruct-2507/) | about 35.5% overall, 22% multi-turn | weak |
| tau2 Telecom, [enterprise benchmark paper](https://arxiv.org/pdf/2511.08042) | 27% instruct, 19% thinking | long-horizon work fails |
| Community 4B fine-tune on tau2 | 59% Pass@4 against 14% for the base model | training helps |
| MAKER, [paper](https://arxiv.org/abs/2511.09030) | 1,048,575 steps with zero errors, using small non-reasoning models | decomposition works |
| 3B model on a Raspberry Pi (anecdotal) | about 50% rising to 84% with atomic checklist steps | task design matters |

Caveats:

- The two BFCL figures come from different benchmark versions and settings, so they are not comparable.
- The enterprise paper argues that tau2 and BFCL do not predict real-world agent performance well.
- MAKER's evidence comes from one domain with perfectly verifiable steps.
- The Pass@4 figure is not the official Pass^k metric.
- Pairing Qwen3-4B with grammar-constrained decoding comes from a [community guide](https://d-central.tech/local-llm-agent-capability/). It is opinion, not measurement.

## What it means for a personal assistant

- **Narrow, well-specified jobs:** set a reminder, look up a fact, read or write a file, route a request, summarize. A 4B model with schema-checked outputs and retries handles these acceptably.
- **Open-ended jobs:** an ambiguous request, a long chain of dependent tool calls, noticing that an earlier step went wrong. This is where 4B models fail, and they fail confidently.

CODEX has already shown this failure. Before commit `8e7cea8`, no tool ever ran in a task tree, because Qwen3.5's tool calls came back as text in `content`. The writer step invented plausible tool results and nothing caught it. A bigger model would invent more convincingly. The fix is a harness that verifies real state, not a larger model.

## Recommendations

1. Keep the 4B model as the default, with a fixed pipeline instead of a free-form agent loop. The harness owns control flow and the model fills narrow slots.
2. Check results with deterministic tests wherever possible. Do not trust the model's account of what it did.
3. Use constrained decoding for tool-call formats.
4. Keep Qwen3.5-35B-A3B as an escalation path for planning and for steps that fail repeatedly. It has about 3B active parameters, so it may be affordable on this hardware.
5. Use CODEX's own evals as the deciding evidence. The benchmarks above are mostly not this workload.

## Open item

Compare the 4B model's pass rate on the `evals/` tasks against the 35B model's. If the gap is small on the tasks that matter, the 4B model is good enough here.

See also [research-task-decomposition-harnesses.md](done-research-task-decomposition-harnesses.md).
