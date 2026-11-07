# Nexus review: what Codex can take from it

A file-by-file review of Nexus, an earlier prototype by the same author, comparing each feature with Codex and deciding whether to add it. Started 2026-11-06, in progress. Findings that changed the plan are already folded into doc 2 ("Nexus: a self-directed loop with drives" and the sections it links) and doc 3; this file keeps the evidence and the reasoning behind each decision.

## What Nexus is

A browser app on a small Node server that runs a cloud Claude model in an unattended loop, one call per cycle (default every 30 s). Homeostatic drives (curiosity, social and others) choose what it does next; it appends to a markdown memory file, reads its own source through a summarising sub-call, may propose source rewrites that wait for the user to apply them, and talks to the user unprompted when its social drive is high. Its last bootstrap prompt framed it as a consciousness experiment: no personality or values given, told to build its own identity. It has no git history; files were read as they stand on disk.

**Method:** read one file (or a small group), compare each feature with the Codex code and docs, give a verdict (update the docs, implement now if quick, skip, or already covered), then wait for the user's next step.

## Files reviewed

### 1. `README.md`

**State of the file:** out of date. Its layout lists `constitution.js`, `drives.js`, `curiosity.js` and `living-mind.js`, which are gone or moved to `legacy/`; it omits the current `nexus.js`, `memory.js`, `self.js`, `state.js`, `trace.js` and `tape.js`. It says Nexus cannot modify its own source right after describing the writable sandbox, and it describes a four-value constitution while `prompt.md` says no values were given. Treated as design intent at one point in time; the code is the truth.

| Nexus feature | Codex equivalent | Verdict and reason |
| --- | --- | --- |
| Drives the model can retune: values clamped, seed drives can be disabled but not deleted, at most 6 self-made drives, at least one always active | Drives proposed only; doc 2 left "who may change them" open and named reward hacking as a risk | **Docs.** A concrete, tested-in-practice set of bounds is a better starting answer than an open question. |
| A drive carries its own prompt and output (`knowledge`, `prose`, `outreach`, `memory`), not only a level | Doc 2 proposed drives "injected into prompts to modulate priority and tone" | **Docs, most important finding.** Nexus found that a drive which only colours the prompt is "a number to narrate around": the model talks about the feeling and nothing changes. In Codex a drive should start an idle job through the scheduler, which makes its effect measurable. |
| Every self-change appended to memory with the model's stated reason | Nothing | **Docs.** A change log turns self-modification into a readable diff the user can review and revert. |
| `REMEMBER:` and `RECALL:` markers in any reply (one recall hop per call) | Harness recall before every call; only the user (`/remember`) and idle steps write memory | **Skip.** Harness-driven recall suits a 4B model better than relying on it to ask; a single model-requested hop when harness recall finds nothing is noted as a possible later test. |
| Small prompt (newest few items and counts), the rest fetched on demand | Core design: fresh narrow contexts | Already covered. |
| Reading its own source; proposing rewrites staged for the user to apply, with backups | Not in scope; "Verified self-authored skills" proposed | **Rejected.** Skills give the same self-improvement path in a form a non-LLM gate can check, and a wrong code change breaks every later run, not one kind of request. |
| Wall clock, time awake, time since last session in the prompt | `todayIso()` in `core/taskTree.ts` gives the date only | **Docs, not code yet.** Elapsed time matters once drives exist ("three days since the last research pass"); before that it has nothing to feed. |
| Session state autosaved and restored, writes serialised | Run checkpoints in `task_runs`, resumed after a restart | Already covered. |
| Cloud transport via `claude -p` (tools disabled, `--safe-mode`) or the API | "Model escalation" names only a local 35B | **Skip.** Against doc 0's local and private aim. |
| Fenced-JSON recovery from prose; loose `LABEL:` format for text people read | Grammar-forced JSON for control flow, prose for answers | Already covered, and grammars are stronger. |
| Unattended loop cost (120 calls an hour at 30 s) | Background worker runs only when idle | Lesson noted: drive-led initiative runs far more often than the idle chain, so it needs a budget (doc 2 already says so). |
| XSS fix (model text inserted with `innerHTML`) | Checked: `renderer/markdown.ts` escapes before `app.ts` inserts | No action. |

**Landed** (commit 4ad0d90): doc 2 "Cognitive loop" gained "each drive owns a behaviour", elapsed time as input, the Nexus bounds under Limits, the change log, and the not-taken items; open question 6 points to the bounds; source rewriting recorded as rejected under "Verified self-authored skills"; a Nexus prior-art table; roadmap item "Goals, drives and initiative" updated.

### 2. `TODO.md` and `prompt.md`

`TODO.md` is a three-part outline: internal state (emotions, values, drives), memory (long-term, always writeable), perception (self-perception of source and memory). `prompt.md` is the bootstrap prompt: a consciousness experiment, no personality or values, build an identity from nothing, memory empty, "you are Claude", with its own source and the internet available.

| Item | Codex equivalent | Verdict and reason |
| --- | --- | --- |
| Emotions as internal state | Mascot moods follow run state (built); doc 2 proposed "mood from content", one model call per run that "could feed the drives" | **Docs.** Add the alternative of computing mood from drive levels and recent outcomes with no model call. Cheaper than a call per run, and the direction is right: drives set the mood, not the mood the drives. Nexus kept emotions and drives as one internal state. |
| Protected values | Enforced in code: trust taint, nothing sent without approval, the autonomy ladder; standing instructions (`CODEX.md`/`AGENTS.md`) in every call | **No change.** Rules the model cannot edit are a stronger form of protected values than a constitution in the prompt. |
| Memory always writeable by the model | Deliberately not: only checked idle steps write | **No change.** Doc 2's error-cascade risk is the reason. |
| Self-perception of source and memory | Recall already shows the model its memory | **Skip source.** The useful self-perception for Codex is its own success rate per domain, which "Self-improving domains" already plans. |
| Identity bootstrapped by the model | No persona; each call has a task-specific prompt | **Not as in Nexus**, which works against fresh narrow contexts. The one transferable idea, stating the plain facts of its situation, is already covered by the date, recall and untrusted-text sections. |

**The user's position (2026-11-06):** Codex could have a very small system prompt setting its identity, personality and tone, at least when it talks to the user (not needed in research and tool stages), and should become more conversational, since the aim is a long-running personal assistant rather than an input-output system. Recorded as open for debate, not decided.

**Landed** (commit 2a9cef0): new open question 8, "Who is it, and how does it talk?", with a doc 2 section "How should it talk to the user?" holding two approaches. *Persona for user-facing replies*: a short user-owned persona in the final-answer, clarification, notification and Inbox stages only, never in planning, research, triage or checks; mail drafts keep the user's voice; tested by pass rate with and without it. *Conversational continuity*: the final-answer stage and `decide` see the last few turns, older turns through recall and the archive; tested with multi-turn eval tasks. Also the mood-from-drives alternative, and a roadmap section "Persona and conversation (open for debate)" whose first step is to decide.

### 3. `memory/nexus.md` and `memory/nexus.state.json`

The record of one real session: 5 cycles on 2026-08-11, about 11 minutes, 36 harness-recorded actions (13 learned, 9 said, 5 source reads, 2 recalls, 2 searches, 1 proposed source change, 8 memory writes). The state file holds counters, the chat, every cycle's prompt and the harness's action trace.

**What the session shows:**
1. **Self-direction turned inward.** Every cycle went to reading its own harness and theorising about its own memory; nothing outward-facing beyond answering the user. Web search was available from cycle 1 and first used in cycle 5, after it had derived memory designs from first principles that the search showed were already published. Its own words: "Thinking hard about my situation is not the same act as investigating my situation."
2. **A summary was mistaken for reading.** Its source reads went through a sub-call that returned one line; for four cycles it treated that line as having read the code. It then graded what it held: read myself, reported by a sub-call, inferred. Test: can I quote it word for word?
3. **Command injection.** Commands were parsed out of text the model had not written: its own help text, echoed back, ran as `RECALL` and `SEARCH`.
4. **An action record helped.** Each prompt began "WHAT YOU HAVE ACTUALLY DONE — recorded by the harness", with totals, a pattern line and a nudge to justify repetition. The model used it to catch and retract its own wrong claims.
5. **Prior art it found:** Generative Agents (retrieval by recency of last access, importance scored when written, relevance) and MemGPT (memory paged between tiers). It also argued for the transcript as the base record, searched directly, with memory as an index over it.

| Finding | Codex equivalent | Verdict and reason |
| --- | --- | --- |
| Involuntary recall ("a notebook, not a memory" was its top complaint) | Harness recall by relevance before every call | Already covered; Codex is ahead here. |
| Decay by time since last access | Known weak point: "Use counts only grow", so long-ago popular topics keep refreshing | **Docs.** It fixes that weak point directly: use keeps an item alive, disuse lets it sink. |
| Importance scored at write time | Facts carry confidence, a different thing | **Candidate only.** One extra score per stored item; test only if decay alone does not fix ranking. |
| Evidence graded read / reported / inferred | Facts grounded against sources; untrusted text under its own headings; but subtask results reach the combine stage as unlabelled summaries | **Docs.** Cheap to add, and Nexus showed a model conflates the three without labels. |
| Commands parsed from echoed text | `textToolCalls` in `core/toolStage.ts` runs `<tool_call>` text in the model's reply as real calls to known tools; a model copying a fetched page could trigger one in a user run (event runs are blocked by the trust taint) | **Known limit, test to write.** Same bug class; not confirmed exploitable. |
| Action record at the top of each prompt | `WRITE_PROMPT` forbids claiming research not done; checks catch claimed changes; idle work has no record | **Docs.** When drives choose idle work, the choosing step should read the harness's record, not the model's account; the same record can become a "while you were away" digest. |
| Transcript as base record, memory as index | Conversation archive (proposed) plus continuity (file 2) | Covered by what file 2 added. |
| Memory lost through formatting (regex, letter case) | SQLite store | Does not apply. |

**Landed** (commit 2427bcc): the decay fix on the roadmap weak point, with Generative Agents and MemGPT in References; evidence labels under "Scratchpad contract"; the action record in "Cognitive loop"; session evidence in the Nexus prior-art section; the tool-call injection check in the roadmap's Reactive assistant known limits.

### 4. `server.js`

The backend: a static host plus HTTP endpoints for model calls (CLI or API transport, a per-call model allowlist), web search as a separate call, the memory file (append for the model, replace for the user), the tape, the bootstrap prompt, saved session state, read-only listing and reading of its own source by allowlisted name, and the sandbox for proposed source changes.

**Main finding: Codex's model can rewrite its own instructions.** `server.js` lets Nexus read `server.js` and `claude-cli.js` but never write them, "because they are what enforces this boundary. A system that can edit its own constraints has none." Codex fails that test. With `allow_file_writes` on, `writeFile` in `core/tools.ts` resolves the path inside the filesystem root and rejects secret-looking files, but nothing stops it writing the working folder's `.codex/` (agents, skills, commands) or `CODEX.md`/`AGENTS.md`, all loaded into every later call. The default root is the working folder (`filesystem_root: '.'`), so when Codex runs from the home folder, `~/.config/codex/` (global instructions, agents, skills) is writable too. `list_directory` hides `.codex`, but writes are not blocked. Event runs cannot write (trust taint), but a user run whose model is talked into it by a fetched page would make that injection permanent, reaching later event runs as well.

| Nexus feature | Codex equivalent | Verdict and reason |
| --- | --- | --- |
| Files that enforce the limits are readable, never writable | `write_file` can reach Codex's own instruction, agent and skill files | **Fix (planned, not yet built):** `writeFile` refuses `.codex/`, `CODEX.md`/`AGENTS.md` and `configDirectory()`, with tests; about ten lines. `/init` writes through the harness, so it is unaffected; the cost is that the user edits those files by hand. Also a standing rule in doc 2: whatever bounds the model is never writable by it, covering the planned persona and prompt files and drive bounds. |
| The tape: every exchange verbatim, append-only, never summarised, inner cycles included, so chosen memory can be checked against what happened | Conversation archive (proposed) covers foreground conversations only; background job prompts and outputs are not kept | **Docs.** Archive background and idle job runs too; the action record (file 3) and the memory drift watch need to trace a wrong fact to the job that wrote it. |
| Staged proposals: diff, syntax check, backup, apply on a click, discard | None; `write_file` replaces a file at once, without a backup; approval is planned only for event actions | **Docs.** Use the same flow for any model-proposed change to a user-owned file (skills, rules, persona suggestions, approved file writes on the autonomy ladder): a diff in the Inbox, a backup before applying, one-step revert. |
| Search as its own call with a strict "report only what you found, then `Sources:`" prompt | `researchOneTopic` summarises with numbered sources and grounding checks | Already covered. |
| Bootstrap prompt in a user-editable file the model cannot change | Persona proposal (file 2) | Already covered; supports the rule above. |
| A "constitution scorer" deliberately run on a weaker model | Checks use the same model; specialist models proposed | Skip: too little detail to act on. |
| Cloud transports, server-side fallbacks, refusal and effort handling | Local only | Does not apply. |
| Endpoints on localhost HTTP with no authentication, so any web page in the browser could POST to `/api/sandbox/…/apply` | Daemon on a Unix socket, which web pages cannot reach | Codex is ahead; a hole in Nexus itself. |
| Source listing with approximate token counts so the model can budget reads | Context budget is the harness's job | Does not apply. |

**Landed** (this commit): the never-writable rule under "Cognitive loop", Limits; background runs in "Conversation archive"; staged proposals in "Verified self-authored skills" and the roadmap's "Act with approval"; the `write_file` gap and its fix as a known limit in the roadmap's Reactive assistant section.

### 5. `claude-cli.js` and `text_ai.sh`

**`claude-cli.js`** is the cloud transport: it runs `claude -p --output-format json` as a subprocess with every Claude Code tool disallowed ("each definition left enabled is input tokens on every single call"; only the search endpoint gets `WebSearch` and `WebFetch` back), slash commands, session persistence and the user's own configuration off (`--safe-mode`). The CLI takes one prompt, so earlier turns are flattened into labelled blocks ("You were asked:", "You previously said:", then "You are now asked:"). At most 2 calls run at once, each with a timeout that kills the process and an optional cost cap, and the result has the same shape as the API transport so `server.js` does not branch.

| Feature | Codex equivalent | Verdict and reason |
| --- | --- | --- |
| Cloud model through the Claude CLI | None | **Skip.** Against doc 0's local and private aim; already recorded as not taken (file 1). |
| Only the tools a call needs, since definitions cost tokens | "Step-wise tool routing" in doc 2 | Already covered. |
| Earlier turns flattened into labelled "You were asked / You previously said" blocks | Requests run standalone; "Conversational continuity" leaves open whether turns pass as text or summaries | **Notes only.** One concrete format for that open question, kept here as an option; too small to be its own approach in doc 2. |
| Per-call timeout and kill; at most 2 concurrent calls | One model behind one lock; looping or repeating output is detected and the run continues | Already covered; parallel calls would only queue behind the lock. |

**`text_ai.sh`** is not part of Nexus: a stand-alone bash toy that keeps a word-pair (bigram) model as plain text, generates sentences by a random walk, and learns from pasted text and good/bad ratings. Its `/ai` command uses Mistral as a teacher: Mistral writes a short prompt, the local model answers, Mistral grades it GOOD or BAD with a corrected example, and the pairs behind the answer are strengthened or weakened and the model retrains on the correction.

| Idea | Codex equivalent | Verdict and reason |
| --- | --- | --- |
| A larger model grades a small model and supplies corrections | Doc 2 prefers non-LLM gates (skills, rules, prompt variants) because model judges drift; escalation to a larger model is proposed | **Skip.** At runtime it breaks the local aim, and as a gate it is weaker than the deterministic checks Codex plans. A stronger model writing eval tasks offline during development would be acceptable; raise it only if hand-written evals become the bottleneck. |
| Learning from the user's good/bad ratings | Autonomy ladder learns from approvals and rejections; "Self-improving domains" uses Inbox approve/reject as its success signal | Already covered, in a stronger form. |
| API key saved as plain text in `~/Documents` | Codex reads the IMAP password from a command | Does not apply; a flaw in the script itself. |

**Landed:** nothing in docs 1–3; this section only.

### 6. `public/js/nexus.js`

The core loop, in the version built *after* the session in file 3: it implements what the model asked for there. Each cycle builds a system prompt from the bootstrap prompt, a menu of verbs, the newest memory and findings, two unrequested memory lines, up to two source files quoted verbatim and the last four chat turns; asks "What are you doing this cycle, and why?" under a harness-written situation report; answers any `RECALL`/`SEARCH`/`REPLAY` lookups (at most 4, one re-ask); then runs up to 6 `SAY`/`LEARN`/`REMEMBER`/`INSPECT`/`PROPOSE` lines in the order written. Every exchange, sub-calls included, goes to the tape. On sleep, one call writes a fixed-section session note.

**Main finding: Nexus dropped drives.** The file opens "Nothing here models what NEXUS is: no drives, no values, no personality document", and `situation()` is documented as "the substitute for drive levels. Everything here is a fact from the record rather than a synthetic number — there is nothing to narrate around, and the pacing pressure comes from noticing a rut rather than from a threshold." The report gives cycle number, time awake, time since the last session, the last 10 harness-recorded actions, totals, the current streak ("your last 3 actions were all …") and time since it last spoke to the user. Taken with file 1 (a drive that cannot cause a behaviour is a number to narrate around), the lesson for Codex is stronger than "a drive owns a job": the pressure to act should be computed each time from facts in the store and the action record (time since a job last ran, stale topics, open items, unanswered mail, approval rates), not kept as stored levels that the model or user nudges. Codex's own scheduler proposal ("Self-improving domains": priority = urgency × expected value × staleness, from the store) already works this way. What stays user-editable is the weights and thresholds of that computation, and Nexus's bounds (file 1) apply to them. Caveat: Nexus is a cloud model with no task to do, so this is one data point, but it is the author's own revision after watching the loop run.

| Nexus feature | Codex equivalent | Verdict and reason |
| --- | --- | --- |
| Situation report of facts from the record instead of drive levels | Doc 2 "Cognitive loop" proposes numeric drive levels stored in the database, each owning a job | **Docs (recommended).** Reframe drives as quantities derived from the store and the action record each time, with only their weights and thresholds stored and bounded. Reason above. |
| Provenance grade (`read`/`reported`/`inferred`) stamped by the harness from what it actually put in the context that turn, not from what the model claims; stored with every kept line | Doc 2 "Scratchpad contract" proposes evidence labels (file 3) without saying who sets them | **Docs (small).** The harness sets the label from where the text came from; the model never labels its own evidence, since the failure being fixed is that it cannot tell them apart. |
| Every kept memory line carries the cycle it came from, a pointer back to the tape | `user_memory` rows have store, kind and status but no link to the episode or conversation they were learned from | **Docs.** Memories learned by `learnFromEpisodes` keep the id of their source episode or conversation; the archive lookups proposed in "Conversation archive" (checking a memory against what the user said) need that link. |
| Session-close note in fixed sections: what I actually did (from the record, not intentions), open questions, what to check next session | `learnFromEpisodes` extracts preferences, projects, corrections and research subjects per episode | **Candidate (docs).** Open questions and things to check could feed the goal list in "Cognitive loop" as user-visible candidates, gated like any goal change. Useful once goals exist; not before. |
| Involuntary recall: each cycle, one memory line best matched to the moment plus one at random, weighted toward older lines | Harness recall by relevance before every call | **Skip.** Random lines cost a 4B model scarce context for likely irrelevant text. Random sampling of old items has a better home in the memory drift watch, which already samples stored items against their sources. |
| Source quoted verbatim in the prompt (2 files, 9,000 characters each) instead of a sub-call's summary | Evidence labels (file 3); capped excerpts passed forward | Already covered by the labels: when a claim must be checked, the write stage needs the quoted text, not a summary. |
| `RECALL` searches memory, tape and chat; `REPLAY` returns a whole past cycle verbatim | Recall over the store; "Conversational continuity" reaches older turns through recall and the archive | Already covered by files 2 and 4. |
| Lookups answered before the reply is final (at most 4, one re-ask); at most 6 verbs per reply; a guard against recursive self-actions | Tool loop with `max_tool_calls` | Already covered. |
| Verbs parsed from any line of free text; placeholder queries like `<query>` filtered out after the session's echo bug | `textToolCalls` known limit (file 3) | Already noted; the filter patched only the symptom seen, which supports testing Codex's case rather than assuming it safe. |
| If the model reasons but never uses `SAY`, its prose becomes the reply | Final-answer stage always produces the reply | Does not apply. |
| Prompt marks "Everything below is written by the harness, not by beatlink" | Untrusted-text headings separate sources of text | Already covered. |
| Bootstrap prompt editable while running, change logged and applied from the next call | Persona proposal (file 2) | Already covered. |

**Landed** (this commit): drives computed from the store and action record, with only weights and thresholds stored ("Cognitive loop" and roadmap item "Goals, drives and initiative"); evidence labels set by the harness ("Scratchpad contract"); memories keep their source episode or conversation id ("Conversation archive"); open questions from a session note as goal candidates ("Cognitive loop"); Nexus prior-art table rows.

### 7. The other `public/js` modules: `trace.js`, `memory.js`, `tape.js`, `state.js`, `self.js`, `mind.js`, `parse.js`, `claude.js`, `ui.js`

Mostly the implementation of features already reviewed in files 1–6. One new lesson, in `trace.js`.

**`trace.js`: the record must say which period it covers.** The model asked for the trace ("I've caught myself claiming actions that didn't fire, but I have no way to detect the reverse case, an action that fired while I reported nothing"), so it is written only where an action really runs, never from model output, and read back so the model can check its account in both directions. Its own header records a bug the model found by reading the file: the prompt labelled `tally()` as "totals this session" while it counted entries restored from earlier sessions too, so the record meant to catch overclaiming was itself overclaiming. The fix marks how many held entries predate this session, reports totals for the session alone, and names carried-over counts as such.

| Module and feature | Codex equivalent | Verdict and reason |
| --- | --- | --- |
| `trace.js`: written only at real fire sites; checked in both directions (claimed but not done, done but not reported) | `checks.ts` flags a change the report does not mention (line 131) and claimed changes or passing tests no action backs up (`unbackedClaims`) | Already covered for foreground runs, in both directions. |
| `trace.js`: totals mislabelled across a session boundary | The action record for idle work is proposed in "Cognitive loop" | **Docs (small).** The record shown to the step that chooses idle work states the period it covers and labels carried-over entries, so a count is never read as recent activity. A wrong count there would push drives (now computed from the record) the wrong way. |
| `memory.js`: one markdown file of typed lines (`KNOWLEDGE`, `FINDING`, `THOUGHT`), parsed by regex; grade and cycle stamped by the harness; monologue buffered, kept out of the prompt but searchable; findings in their own prompt section so they do not scroll out | SQLite store with recall by relevance; harness-set labels and source links added in file 6 | Already covered; Codex's store is sturdier than regex over markdown (file 3 recorded lines lost to formatting). |
| `tape.js`: verbatim log, cycle-tagged lines, `REPLAY` of a cycle within a character budget | Archive proposals (files 2 and 4) | Already covered. |
| `state.js`: debounced saves serialised so they cannot land out of order; search by plain term overlap, chosen because "a predictable ranking is easier for NEXUS to reason about than an opaque one" | SQLite in WAL mode; hybrid word and vector recall merged by reciprocal rank fusion | Covered for saves. **Skip** the search argument: Codex's model does not reason about its own ranking, and meaning-based recall finds differently worded facts that term overlap misses. |
| `self.js`: prompt saved and proposals applied only from click handlers, never from a cycle | Persona file and staged proposals (files 2 and 4) | Already covered. |
| `mind.js`: wake/sleep timer with a generation counter so an old chain cannot re-arm and double the rate | One scheduler loop in the daemon | Does not apply. |
| `parse.js`: degrades silently (strips every fence, rescues the outermost braces, returns a fallback), which the model itself flagged as making failures look like legitimate nulls | Grammar-forced JSON with validation | Already covered; Codex's parsers fail visibly. |
| `claude.js`: one client, a rolling history cap, refusals raised as errors | Local model behind the daemon | Does not apply. |
| `ui.js`: all model text inserted with `textContent` | `renderer/markdown.ts` escapes before insertion (file 1) | Already covered. |

**Landed** (with file 8): the period and carried-over labels on the action record in "Cognitive loop".

### 8. `public/index.html` and `public/css/` (skimmed)

One page: control (wake, sleep, cycle slider from 5 to 120 s, full reset), a reasoning stream coloured by kind of action, the conversation, an editable memory file ("Yours to edit"), the bootstrap prompt in an editable panel ("edit it while it runs and the change lands on the next call"), proposed code changes with diffs, and counters (cycles, times it spoke, things learned, actions taken). `base.css` holds the shared structure and `theme-nexus.css` only the theme's tokens; both still carry styles for the removed constitution strip and values view.

| Feature | Codex equivalent | Verdict and reason |
| --- | --- | --- |
| Bootstrap prompt editable in the window, applying from the next call | Persona proposal (file 2) names a user-owned file only | **Docs (small).** The persona is editable in the window as well as on disk, with a change applying from the next call; editing it should not need a rebuild or a restart. |
| Reasoning stream coloured by kind of action | Task graph with each step drawn as its own box | Already covered. |
| Proposed changes shown as diffs with Apply and Discard | Staged proposals in the Inbox (file 4) | Already covered. |
| Counters of cycles, messages, things learned and actions | "While you were away" digest from the action record (files 3 and 7) | Already covered. |
| The whole memory file editable as text | `/remember`, `/memories`, `/forget` and the knowledge view | **Skip.** Free-text editing of a structured store would bypass the source links and statuses that files 3 and 6 rely on. |
| Leftover styles for the removed constitution and values views | None | Does not apply; dead code in Nexus. |

**Landed** (this commit): the persona edit-in-window note under "Persona for user-facing replies".

## Still to review

1. `legacy/`: `drives.js`, `personality.js`, `curiosity.js`, `emergent.superseded.js`, `living-mind.scheduler.js`, the original HTML files (skim)
2. `sandbox/.backups/…/nexus.js`, compared with the current `nexus.js` only
