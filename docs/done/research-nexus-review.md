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

## Still to review

1. `claude-cli.js`, `text_ai.sh`
2. `public/js/nexus.js` (758 lines, the core), then `mind.js`, `memory.js`, `self.js`, `state.js`, `trace.js`, `tape.js`, `parse.js`, `claude.js`, `ui.js`
3. HTML and CSS (skim)
4. `legacy/`: `drives.js`, `personality.js`, `curiosity.js`, `emergent.superseded.js`, `living-mind.scheduler.js`, the original HTML files (skim)
5. `sandbox/.backups/…/nexus.js`, compared with the current `nexus.js` only
