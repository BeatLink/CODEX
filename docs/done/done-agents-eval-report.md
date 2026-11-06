# Agents: status report

Where the agent hierarchy stands, what the evaluation has shown so far, and what comes next. The design is in [agent-hierarchy.md](done-agent-hierarchy.md).

## What we want to achieve

CODEX makes a small local model (a 4B Qwen on a 4 GB GPU) more capable by working each request as a tree of narrow tasks. Agents extend that idea. A task can hand its work to a named specialist, such as mail or contacts, that has its own instructions, its own MCP servers and its own sub-agents. The claim to test is that a small model chooses and uses tools more reliably when it sees only the few tools of one specialist than when it sees every tool at once.

The hierarchy is worth keeping only if it beats the flat tree on tool tasks. Persistence, per-agent memory and nested views are only worth building after that.

## Done

- **Prototype (landed).** The `delegate` approach, agent files with YAML front matter in `~/.config/codex/agents/` and `<folder>/.codex/agents/`, and nested task-tree runs capped at depth 3. An MCP server that any agent claims is hidden from every other run, so a top-level run sees only the tools of the agents' own scope. It is covered by scripted-model unit tests.
- **Agents eval (this branch, not yet run to completion).**
  - `evals/fake_mcp_server.mjs` and `evals/fake_catalogue.json`: six canned MCP servers (mail, calendar, notes, contacts, weather, todos) with 32 tools between them, so no real accounts are needed.
  - `evals/agents/`: seven agent files. The `comms` agent has `mail` and `contacts` as sub-agents, which tests nesting.
  - `evals/agents_tasks.json`: eight tasks. Six need one specialist, one needs two hops (find a contact, then search their mail), and one needs two unrelated specialists.
  - A new `agents` runner beside the flat `tree` runner, and a per-task `servers` field. The two runners differ only in whether the agent files are present.
  - Tests for the task loader and the fake servers (42 pass in `src/core/evaluation.test.ts`).

## Results so far

Only two kinds of run have happened, and they don't amount to a comparison.

- A first run on `inbox-newest` scored 0/2 on both runners (`tree` 634 s, `agents` 300 s). The cause is unknown.
- A second run of the `agents` runner on the same task passed 2/2 in 239 s (7 model calls, 314 tokens).
- The model is the 4B one (`model.gguf` links to Qwen3.5-4B-UD-Q4_K_XL). The 35B model was never loaded, and its file has been deleted from `models/`.
- Runs are slow, about 30 s per model call. The machine's load average was about 15 during the second run, and I have not confirmed whether the model runs on the GPU or the CPU.

## Next

1. Find out why runs are slow: check the loaded `gpu_layers` and whether CUDA is used, and rerun when the machine is quiet (no borg backup).
2. Run one round of 16 runs (8 tasks, `tree` and `agents`). If the runners differ, repeat for several rounds with `--repeat`. Command: `flock /run/user/1000/codex-gpu.lock node dist/core/evaluation.js --tasks evals/agents_tasks.json --runners tree,agents --repeat 3 --output <file>`.
3. Find out why the first run failed, by saving answers and tool calls for a failing run.
4. If agents win, build what the prototype left out: per-agent memory and scratchpad, resuming inside an agent, showing the nested tree in the interfaces, and per-agent skills and tool allow lists. If they do not, change or drop the idea.

## Limits of the eval

The tools return canned replies, so it measures tool choice and delegation, not real MCP behaviour. Eight tasks and a 4B model give noisy pass rates, so any difference needs repeated rounds before it counts.
