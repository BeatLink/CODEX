# Agent hierarchy

A design for letting a task hand its work to a named specialist agent, which works it as its own task tree with its own tools, instructions and memory. The task tree stays the way every request is worked; agents decide who works a task and what that worker can see.

## Why

The task tree makes one model call small and narrow, but every call in it still sees the same world: every enabled tool, one set of instructions, one memory. That does not scale with what the harness can do.

- **Tools crowd the window.** Each MCP server adds tool schemas to every `act` call. A small model with a 6,144-token window picks worse the more tools it is shown, and a mail server, a calendar server and a home-automation server have nothing to do with each other.
- **One decision cannot choose well among many things.** Picking one of three specialists is an easy constrained choice; picking one of fifty tools is not. Splitting the choice across levels keeps each one small.
- **Knowledge that only one kind of work needs still competes for room.** How the user likes email drafted is noise in a file-editing task.

An organisation solves the same problem with roles: the assistant knows who handles mail, the mail clerk knows which system sends it, and neither needs the other's manuals.

## What an agent is

An agent is a persistent configuration, not a running process. There is one model on one GPU and one request runs at a time, so agents never run in parallel; delegation adds serial hops, not concurrency. An agent is defined by:

| Field | Meaning |
| --- | --- |
| `name` | The file name, used in the decision's `agent` choice |
| `description` | One line the parent reads when choosing; the only thing it knows about the agent |
| instructions | The Markdown body; added to the standing instructions for every call the agent makes |
| `mcp_servers` | Names of the MCP servers only this agent can use |
| `agents` | Names of the agents this one can delegate to |

Agents are Markdown files in `~/.config/codex/agents/` and the working folder's `.codex/agents/`, like skills and user commands. A folder's file replaces a global one of the same name.

```markdown
---
description: Reads, drafts and sends the user's email.
mcp_servers: mail
agents: contacts
---
Keep replies short. Never send a message without showing the draft first.
```

An agent no other agent lists is a top-level agent: the request's tasks can delegate to it directly. An agent listed by another is reachable only through that parent, so the top level sees few choices.

## How delegation works

1. A task's decision schema gains a `delegate` approach and an `agent` field, both only when the task's agent has children it may use and the agent depth limit is not reached.
2. When the model picks `delegate`, the task runs a nested `TaskTreeRun`. Its request is the task's prompt and deliverable plus the results of the tasks it depends on; the original request is not passed down.
3. The nested run uses the agent's instructions after the parent's, only the agent's MCP servers, and the agent's own children as its delegation choices. It decides, gathers, writes and checks like any run, and cannot ask the user a clarification question.
4. Its final answer becomes the delegating task's result, with the nested root task's status. The delegating task is not checked a second time.
5. The parent's evidence, found addresses and tool use are shared with the nested run, so the checks that compare a result with its evidence still work across the boundary.

Tool exposure is the point of the design. A server named in any agent's `mcp_servers` is withheld from every run but that agent's, so the top-level `act` call sees only the servers no agent claims.

### Limits

- Agents nest at most three deep, as in EffGen, since each hop loses detail and can misroute.
- The nested run keeps the node and depth limits of its own task tree.
- A task whose delegation raises an error fails like any other task; its parent re-plans.

## Prototype

Built in the first version:

- `codex/agents.py` loads agent files and works out which agents a run can delegate to.
- `delegate` in the task tree, with the nested run, per-agent MCP servers and per-agent instructions.
- The nested tree is not shown in the interfaces; the delegating task shows `delegate` and the agent's name.

Not built:

- **Persistence.** Agents have no memory of their own yet. The intended shape is a memory scope per agent in the knowledge store, filled by learning from the agent's episodes, plus a scratchpad folder under the state directory.
- **Resuming inside an agent.** A checkpoint saves the delegating task, not the nested run, so a resumed run starts the delegation again.
- **Showing the nested tree** in the interfaces.
- **Per-agent skills and tool allow lists** beyond MCP servers.

## How to tell whether it helps

Run `codex eval` on a task set with the same MCP servers configured flat and behind agents. The measure is the share of tasks that reach the right tool and finish, with the number of model calls beside it, since every hop costs calls. If agents do not beat flat on tool choice, the added calls are not worth it.

## Risks

- **Compounding error.** At 90% per hop, three hops give about 73%. The check of the nested run, and the real-state checks on its actions, are what hold this up.
- **Misrouting.** A vague `description` sends tasks to the wrong agent. Descriptions are the part to write carefully.
- **Sprawl.** Many hand-written agents are a maintenance cost; start with a few.
