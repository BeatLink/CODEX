# Task-decomposition harnesses for small local LLMs

Existing projects and strategies that break work into very granular tasks and run each with fresh context, so small models on limited hardware can punch above their class. Gathered 2026-11-05 as inspiration for CODEX.

## Closest match: MAKER (Cognizant AI Lab, Nov 2025)

- Splits a task as far as it will go, so each agent gets one step and only the context that step needs.
- Each step is sampled several times and decided by "first-to-ahead-by-K" voting. The first answer to lead by K votes wins.
- "Red-flagging" throws away answers that look confused, such as ones that are too long or badly formatted. It does this before they can vote, then resamples.
- Ran a 1,048,575-step Towers of Hanoi task with zero errors. The authors found small non-reasoning models were enough, and the number of votes needed grows only logarithmically with the number of steps.
- Caveat: the evidence comes from one domain with a perfectly specified, verifiable step. Real coding tasks are harder to split cleanly.
- Sources: [paper](https://arxiv.org/abs/2511.09030), [Cognizant post](https://www.cognizant.com/us/en/ai-lab/blog/maker)

## Other relevant work

- **EffGen** runs decomposition on the same small local model that does the work. Sub-agents get limited autonomy, nesting is capped at depth 3, and sequential chains pass each subtask only its predecessor's output. ([paper](https://arxiv.org/pdf/2602.00887))
- **Recursive decomposition with fresh contexts**: a write-up on 30B-class local models says a long context window is possible but slow. Their fix is recursive decomposition, where each sub-task gets a fresh window and scratchpads carry what must persist. ([post](https://cyberdagger.com/blog/scratchpads-recursive-decomposition-c2-agent-generation/))
- **Context-Folding** trains agents to fold their working context, keeping the active context about 10x smaller at similar quality. It needs training, so it is less useful as a harness idea. ([paper](https://awesomepapers.io/papers/2510.11967))
- **brainos-orchestrate** has the model plan JSON steps, passes only a capped excerpt of each finished step's output forward, and generates a corrective sub-plan when a step fails. ([source](https://docs.rs/crate/brainos-orchestrate/0.5.0/source/src/decompose.rs))
- **Terminus-4B** post-trains a small model for narrow terminal subtasks as a subagent. ([summary](https://awesomepapers.io/papers/garg2026terminus))
- **Practitioner report** on a 3B quantized model on a Raspberry Pi: success rate about 50%, rising to 84% after switching to atomic checklist steps. Other changes were checking real system state instead of trusting the model's own report, and capping retries at three. Anecdotal, not a benchmark. ([post](https://dev.to/trismegistus/what-3-months-of-running-an-ai-agent-on-a-raspberry-pi-taught-me-about-task-design-1m2l))

## Not verified

The searches found nothing on Agentless or Aider's architect/editor split. From memory only: Agentless uses a fixed pipeline of localize, repair and validate instead of an open agent loop, and Aider separates "plan the change" from "write the edit".

## Ideas worth borrowing

1. **Fresh context per step.** Each call gets only the step instruction and the specific inputs it needs, never the whole history.
2. **Cheap redundancy.** Sample a few times and vote, with red-flag filters, instead of using a bigger model. Small-model calls are cheap and parallelizable.
3. **Verify, don't trust.** Check the step's output with a deterministic test, schema or system check wherever possible. Cap retries and escalate or replan on failure.
4. **A fixed pipeline instead of free-form agent loops**, as in Agentless. The harness drives control flow and the model only fills in narrow slots.
5. **A scratchpad or structured state passed between steps**, so the model does not have to remember anything.
