# Roadmap

Statuses come from research files only until the codebase review below is done.

## Next: codebase review (later, separate pass)

Review the existing code to find what is already implemented but undocumented, what designs have changed, where the project stands, and what to do next. Then reconcile docs 1–3 and this roadmap.

## Agent hierarchy

Open work, in no fixed order:

1. Per-agent memory scope in the knowledge store, learned from the agent's episodes; scratchpad folder under the state directory.
2. Checkpoint and resume inside a nested run.
3. Show the nested tree in the interfaces.
4. Per-agent skills and tool allow lists.

### Validation

Run `codex eval` on one task set with the same MCP servers configured **flat** vs **behind agents**. Measure the share of tasks that reach the right tool and finish, and the number of model calls beside it (each hop costs calls). If agents do not beat flat on tool choice, the added calls are not worth it, and the feature should be reconsidered.
