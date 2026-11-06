# Reactive assistant

A design for turning CODEX from a harness that answers requests, with a knowledge base working in its idle time, into a personal assistant that reacts to events such as an email arriving, and uses idle time to prune, research, restructure and consolidate what it knows. The task tree stays the way work is done; this design changes what starts work, what work produces, and what the assistant is allowed to do on its own.

## Why

Today a request is the only trigger. The daemon already lives for a long time, owns the model and the knowledge store, and runs a preemptible background loop, but three things keep it from being an assistant.

- **Nothing can start work except the user.** The background loop is a fixed chain (research, index, learn, consolidate) and has no way to be told that something happened.
- **The store is built around topics.** An assistant needs to know people, threads and commitments, with a lifecycle (open, done, overdue) that facts and memories do not have.
- **Work always ends in a reply.** A reactive assistant's result is a proposal: a draft, a calendar entry, a notification, a filed item, or nothing.

## Decisions

- **Events go in a durable queue.** An event is a row in SQLite, not a callback, so it survives a restart and can be deduplicated, prioritised and inspected. Connectors (mail, calendar, file watchers, timers, webhooks) only append events.
- **One scheduler, three priority classes.** Interactive work (a user request) outranks reactive work (events), which outranks maintenance (research, indexing, learning, consolidation). The preemption already in place (`BackgroundPaused`) is how a higher class takes the model from a lower one.
- **The task tree stays the work engine.** An event that needs real work becomes a task tree whose request is the event plus recalled context. Cheap triage comes first, so the small model does not spend a tree on a newsletter.
- **Results are actions, not replies.** A finished event leaves zero or more rows in an `actions` inbox, each proposed, then approved, rejected or done.
- **Trust follows provenance.** Every event carries a trust level (`user` or `external`). Third-party text, such as an email body, is the main prompt-injection route, so a run started by an external event may not use side-effecting tools without approval. Only the user, or a rule the user wrote, widens that.
- **Autonomy is a ladder per event class**: observe, notify, draft, act with approval, act unattended. Rules are learned from approvals and rejections and stored as memories.
- **Entities and commitments get their own tables.** They have a lifecycle that the topic, fact and memory tables do not model, so they are not folded into the graph.

## Data

| Table | Holds |
| --- | --- |
| `events` | Source, type, dedupe key, trust, priority, JSON payload, status (`pending`, `running`, `done`, `ignored`, `failed`), outcome, error, times |
| `actions` | The proposal an event produced: kind, title, body, JSON payload, status (`proposed`, `approved`, `rejected`, `done`), the event it came from |

An event is unique per source and dedupe key when it has a key, so a connector can post the same message twice safely. Later phases add entities, commitments and observations.

## Scheduler

```
loop:
  suspended / paused / a run is active   → wait
  otherwise run the first job that has work, in this order:
    reactive     handle_events
    maintenance  research, index, learn, consolidate
```

A job is a name, a class and a step with the signature the background steps already use. The daemon builds the list from its dependencies, so tests replace any of them. Event handling is a step like the others: it claims one event, runs the handler registered for its type, and records the outcome. A handler that is paused by a foreground run puts its event back in the queue.

## Phases

1. **Plumbing** (landed with this document): the `events` and `actions` tables, the job list, event handling with a handler registry, a built-in `notify` handler, and the `post_event`, `events`, `actions` and `resolve_action` daemon methods. A user request is not yet an event.
2. **First connector** (landed): Maildir folders, with triage (header heuristics first, then a schema-constrained model call) and notify-only actions. Maildir came before IMAP because a synced Maildir (mbsync, offlineimap) needs no credentials in CODEX, and the daemon never holds a mail password. A direct IMAP connector can follow once credentials have a safe home.
3. **Trust taint and events as task trees** (landed): a run started by an `external` event is held to research and writing (see Trust below). `email.draft` drafts a reply for mail that waits for one, `user.request` works a request the user left for later, and both end as actions in the Inbox. An IMAP connector reads mailboxes whose password comes from a command.
4. **Approval and the autonomy ladder**: acting with approval and acting unattended, with rules learned from approvals and rejections. Not started. Until it exists no event run can change anything.
5. **Entities and commitments**, then idle jobs driven by them: pre-research for tomorrow's meetings, stale-commitment sweeps, entity profiles from episodes, a daily digest.

## Mail

`MailConnector` ([mail.ts](../src/core/mail.ts)) polls the `new/` folder of each Maildir in `mail_maildir_paths` on every background pass. A message becomes an `email.received` event with `external` trust, its Maildir name (without the client's flags) as the dedupe key, and a payload of sender, recipient, subject, date, message id, a `bulk` reason and up to 4,000 characters of body text. Messages older than `mail_max_age_days` are left alone, so connecting an old mailbox does not flood the queue, and at most 25 are queued per poll.

The handler ([triage.ts](../src/core/triage.ts)) works in two steps.

1. **Without the model**: mail marked automatic, bulk, from a list, or from a no-reply sender is `ignored` with the reason.
2. **With the model**: one call returns a summary, a category, whether a person is waiting for a reply, and an importance. The email is shown inside the untrusted-data fence, the call has no tools, and the reply is a schema-constrained classification, so a hostile email can at worst mislabel itself. Mail of low importance that waits for no reply is `ignored`; the rest becomes a `notify` action carrying the summary. When the model fails or answers badly the mail still becomes a `notify` action, marked as not triaged.

## Trust

`executeTaskTree` takes `trust: 'user' | 'external'` ([taskTree.ts](../src/core/taskTree.ts)). An external run:

- cannot write files, run tests or call MCP tools, whatever the settings say, so the `act` approach is never offered;
- is held to the `draft` mode, and does not read a memory command or a `/do`-style prefix from the first words of its prompt, since those words came from outside;
- passes the taint to every agent it delegates to, and saves it with its checkpoint so a resumed run is not widened;
- may search the web but not fetch pages or read local files in its research, so nothing it has read can be sent out in a URL.

Event runs (`eventTree.ts`) go further: they never act, even for a `user` event, because nobody is there to approve a change. A `user.request` can use the web and local files, and its answer waits in the Inbox. Approving and then carrying out a change belongs to the next phase, and until it lands acting stays in the foreground, where the user is asked.

## Drafting and requests

Triage queues one `email.draft` event (priority below the triage events, dedupe key from the message id) for mail that waits for a reply, when `mail_draft_replies` is true. The draft handler shows the mail to a task tree inside the untrusted fence and proposes the result as a `draft` action; nothing is ever sent. `queue_request` (a daemon method the window may call) queues a `user.request` event with `user` trust.

## IMAP

`ImapConnector` ([imap.ts](../src/core/imap.ts)) reads each account in `mail_imap_accounts` at most every two minutes, over TLS with the certificate checked. The password comes from running `password_command` (a program and its arguments, never a shell string) at poll time, so settings and the database never hold it, and a failed login reports only that the server refused it. The mailbox is opened read-only (`EXAMINE`) and messages are fetched with `BODY.PEEK`, so polling changes nothing on the server. A message is keyed by the mailbox's UIDVALIDITY and its UID, so it is queued once.

## Limits to design around

- One model and one lock mean events are handled one at a time. A mailbox sync needs coalescing and a backlog policy, not a call per message.
- A 6,144-token window cannot hold a long thread; threads need rolling summaries in the store and the existing condense-then-trim path.
- Idle work needs a budget, or it turns into noise.
- Event handling shares the background pause: with background work paused, events wait.
