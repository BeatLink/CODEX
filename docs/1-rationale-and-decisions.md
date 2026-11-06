# Rationale and decisions

## Agent hierarchy

**Problem.** The task tree keeps each model call small and narrow, but every call still sees the same world: all enabled tools, one set of instructions, one memory. That does not scale.

- **Tools crowd the window.** Each MCP server adds tool schemas to every `act` call. A small model with a 6,144-token window picks worse the more tools it sees, and unrelated servers (mail, calendar, home automation) have nothing to do with each other.
- **Choosing among many is hard; among few is easy.** Picking one of three specialists is an easy constrained choice; one of fifty tools is not. Split the choice across levels.
- **Specialist knowledge is noise elsewhere.** How the user likes email drafted should not occupy room in a file-editing task.

Analogy: an organisation uses roles. The assistant knows who handles mail; the clerk knows which system sends it; neither needs the other's manuals.

**Decisions.**

| Decision | Why |
| --- | --- |
| Agents are persistent configuration, not running processes | One model, one GPU, one request at a time. Delegation adds serial hops, never concurrency. |
| Agents decide who works a task and what the worker sees; the task tree stays the way every request is worked | Reuses the existing machinery; no second execution model. |
| A tool server claimed by any agent is withheld from every other run | Tool exposure is the point: top-level `act` sees only unclaimed servers. |
| Nested run receives only the task's prompt, deliverable and dependency results, not the original request | Keeps the specialist's context narrow. |
| Parent's evidence, found addresses and tool use are shared with the nested run | Evidence-vs-result checks still work across the boundary. |
| Nested run cannot ask the user a clarification question | Clarification stays with the top level. |
| Delegating task is not checked a second time | The nested run already checks its own answer. |
| Max nesting depth 3 (as in EffGen) | Each hop loses detail and can misroute. |
| Files in Markdown + YAML front matter, global and per-folder, folder wins | Same convention as skills and user commands. |
| Start with a few hand-written agents | Many agents are a maintenance cost. |

## Risks

- **Compounding error.** At 90% per hop, three hops ≈ 73%. Mitigated by the nested run's own check and real-state checks on its actions.
- **Misrouting.** A vague `description` sends tasks to the wrong agent; it is the only thing the parent knows about an agent, so write it carefully.
- **Sprawl.** See above.
