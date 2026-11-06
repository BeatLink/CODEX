# Reactive assistant: where things stand

A status report on the move from a request-and-answer harness to an assistant that reacts to events and works while idle. The design is in [reactive-assistant.md](reactive-assistant.md); this report says how far it has got, what the finished thing looks like, and what is left.

## Where things stand

Written, tested with fake models and fake servers, and landed:

| Piece | State |
| --- | --- |
| Durable `events` and `actions` queues, scheduler with reactive jobs before maintenance | Landed |
| Handler registry, `notify` events, `post_event`, `events`, `actions`, `resolve_action` | Landed |
| Maildir connector and mail parser | Landed |
| Mail triage: header heuristics, then one schema-constrained model call | Landed |
| Inbox page, tray entry and desktop notification | Landed; typechecked, not seen in a real window |
| Trust taint: an `external` run cannot act, write, test, call MCP tools, fetch pages or read files | Landed |
| Events worked as task trees: `email.draft` (a reply draft) and `user.request` (a request left for later) | Landed |
| IMAP connector, read-only, password from a command | Landed; tested against a fake server only |
| `queue_request` daemon method, allowed from the window | Landed; no button yet |

Never tried against the real thing: a real mailbox, a real IMAP server, the real model drafting a reply, or the Inbox in the Electron window. Every behaviour above is covered by unit tests with stand-ins, so the first live run may turn up differences.

What the assistant does today: mail arrives (Maildir or IMAP), automatic mail is dropped without the model, the rest is summarised and ranked by the model, mail that waits for an answer gets a drafted reply, and everything lands in the Inbox as a proposal to read, mark done or dismiss. Nothing is sent and no event run changes anything.

## The ideal

An assistant that notices, prepares and asks, and acts alone only where the user has said it may.

- **Many sources, one queue.** Mail, calendar, files, timers and webhooks all post events; the same queue, scheduler and Inbox serve them.
- **Work shaped like the event.** Cheap triage first; a task tree only when the event needs one; a draft, a filed item, a calendar entry or nothing as the result.
- **A ladder of autonomy per kind of event.** Observe, notify, draft, act with approval, act unattended. The user moves an event class up the ladder by approving, and a rejection moves it back down. The rules are stored as memories the user can read and delete.
- **Untrusted text never steers.** Anything a stranger wrote is fenced, read without tools or with the narrowest set, and cannot widen its own permissions.
- **A model of the user's world.** People, threads and commitments with a lifecycle (open, done, overdue), so "who am I waiting on" and "what did I promise" have answers.
- **Idle time with a purpose.** Pre-research for tomorrow's meetings, a sweep of stale commitments, entity profiles built from past requests, a daily digest, with pruning and consolidation as upkeep rather than the main job. Idle work has a budget so it does not turn into noise.
- **Always yields to the user.** A foreground request takes the model from any background run within one call.

## What is left

1. **Look at it running.** Open the window with a Maildir or IMAP account and a real model, and check the Inbox layout, the notification, the tray entry, and the quality and length of drafts. This is the cheapest way to find what the tests cannot.
2. **A request box in the Inbox.** `queue_request` exists and the window may call it; the page needs an input and a way to show a result next to its request.
3. **Act with approval.** The next rung. An approved `draft` or `result` action should be able to carry out a change: send the reply through a mail command the user names, file an item, write a note. Approval must name the exact change, and the executing step runs with `user` trust and only that tool. This is the work that turns proposals into help.
4. **Learned rules.** Record each approval and rejection against its event class and sender, and use them to skip triage for senders the user always ignores and to promote reliable classes up the ladder.
5. **Entities and commitments.** New tables, filled from mail and from the user's own requests, with a lifecycle and a sweep for overdue items.
6. **Goal-driven idle jobs.** Replace the fixed research, index, learn, consolidate chain with jobs that are chosen by what the store says is stale or upcoming, each with a budget.
7. **More sources.** Calendar and a file watcher are the next connectors, because they feed the commitments and meeting pre-research jobs.
8. **Upkeep.** Prune finished events and old actions, add a mail settings page, and coalesce a large mailbox backlog instead of handling one message per pass.

## Known limits

- One model and one lock: events are handled one at a time, and a draft run holds the model for the whole tree, so a foreground request waits for the current model call to finish and the run is stopped and retried.
- A stopped event run leaves a resumable checkpoint in the task-run table; they are not cleaned up yet.
- A 6,144-token window cannot hold a long thread. Only the body of the one message is used, up to 4,000 characters.
- Triage and drafting depend on a small model's judgement. The taint limits the damage of a fooled model to a wrong summary or a poor draft, which the user reads before anything happens.
- The IMAP connector reads one folder per account, checks for new mail at most every two minutes, and uses TLS on the given port only (no STARTTLS).
