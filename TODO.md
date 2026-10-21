# TODO

## postponed

- [ ] Purge the removed LM Studio notes (`docs/design/lm-studio-models-and-settings.md`, commits 46b2616 and 538c143) from the public history

## Planned

- [x] Work each request as a tree of tasks that the model decides, decomposes, checks, and re-plans
- [x] Remove the eight-stage pipeline and work every request as a task tree
- [x] Resume an unfinished task tree after the daemon restarts
- [x] Show each task's result when its row is chosen in the interfaces
- [ ] Subagents / refinement loops
- [x] Tool calling
- [x] Web search
- [x] Local filesystem access
- [ ] Add patch-based edits and Git diff/status tools
- [ ] Add a bounded command runner for targeted checks
- [ ] Iterate code changes from verification failures
- [x] Add approval gates for consequential actions
- [x] Read standing instructions from SMARTHARNESS.md or AGENTS.md, global and per folder, into every model call
- [x] Let the user remember, list, and forget memories with /remember, /memories, and /forget
- [x] Let the user define slash commands as Markdown files, and add /init to write a folder's SMARTHARNESS.md
- [x] Recall user memories by relevance and recency, keep project memories to their folder, and record why each holds
- [ ] Benchmark on real maintenance tasks
- [x] Keep the loaded model between requests and share it with the background worker
- [x] Return structured JSON from stages using llama.cpp schema-constrained output
- [x] Route each request by task type so simple requests skip stages they do not need
- [x] Route each request to an answer, draft, or execute mode with its own stages, chosen by a short router call or by the user
- [x] Check execute-mode reports against the recorded file writes and test runs
- [x] Let stage 1 decide whether research is needed instead of keyword regexes
- [x] Let the model write focused search queries instead of reusing the prompt
- [x] Turn the plan into numbered steps and run each step as its own small call
- [x] Make the critique mark each requirement pass or fail and revise only what failed, in a bounded loop
- [x] Add checks that do not rely on the model, such as cited URLs appearing in the evidence
- [x] Count tokens with the model's tokenizer instead of a characters-per-token estimate
- [x] Never trim the original request
- [x] Summarize older stage output instead of cutting it
- [x] Give each stage its own reply token budget
- [x] Add an eval harness comparing the bare model with the pipeline on a fixed task set
- [x] Add schema migrations to the knowledge store
- [x] Store atomic facts with source URL and confidence instead of one summary per topic
- [x] Stop copying the topic summary onto every source row
- [x] Store user memory (preferences, projects, corrections) extracted from each run
- [x] Store episodic memory of past tasks, plans, and outcomes
- [x] Retrieve user and episodic memory for every prompt, not only research prompts
- [x] Place new facts under a parent topic so the topic tree is a real hierarchy
- [x] Keep a summary on each parent topic built from its children
- [x] Return a matched fact with its chain of parent summaries during retrieval
- [x] Record entity relationships from extracted facts in the graph
- [x] Queue background research from searches that found nothing
- [x] Save fetched page summaries and queue successful searches for fact extraction
- [x] Answer from stored summaries without searching again
- [x] Queue background research from unsupported claims
- [x] Queue background research from topics that keep coming up in requests
- [x] Fetch full pages during background research, not snippets only
- [x] Merge duplicate facts, flag contradictions, and prune unused facts in the background
- [x] Merge duplicate topics and user memories and re-file topics under better parents in the background
- [x] Track memory usage counts
- [x] Refresh topics by usage and staleness
- [x] Add embedding retrieval with sqlite-vec and combine it with FTS5 ranking
- [x] Count recalled memory as evidence in the task tree's URL and value checks, as the pipeline does
- [x] Recall memory for each task's own prompt and search queries, not only once for the whole request
- [x] Rank recalled facts by FTS5 score and term overlap instead of requiring half the prompt's terms
- [x] Retrieve along the topic tree: pick the best-matching branch, then search only the facts under it
- [x] Add one-hop graph neighbours of entities named in recalled facts to the remembered context
- [x] Give facts an expiry from their source and recheck them when their topic is refreshed
- [x] Check that an extracted fact's numbers, dates, and distinctive words appear in the source it cites
- [x] Queue background research from the user's recorded projects
- [x] Compare differently worded duplicate topics and facts during consolidation, once embeddings exist
- [x] Rename topics named after raw search queries during consolidation
- [x] Run background work on its own model, with its own settings, cache and lock, unloaded when idle
- [x] Size the background model against free RAM in Auto size
- [x] Add SQLite-backed knowledge storage with schema initialization and version guard
- [x] Add full-text knowledge retrieval and source provenance/freshness metadata
- [x] Add SQLite graph tables for topics, entities, and relationships
- [x] Reuse stored search evidence before searching the web; refresh stale/missing evidence
- [x] Add a bounded background research queue populated from explicit topics and research activity
- [x] Run background research automatically only while no foreground prompt is active
- [x] Prevent background model work from competing with active prompt processing
- [x] Add validated settings for knowledge storage and background worker behavior
- [x] Add TUI controls for enabling/configuring and pausing background research
- [x] Add TUI view for background worker status and model thinking/progress
- [x] Add visual TUI browser for stored topics, facts, sources, and graph relationships
- [x] Add focused tests for SQLite storage, graph queries, retrieval, worker scheduling, and TUI views
- [x] Document storage, background worker, configuration, and privacy/resource behavior
- [x] Run the eval harness with the knowledge store empty and filled to measure what recall adds
- [x] Score recall against a fixed set of questions with known relevant facts
- [ ] Cap the knowledge store's size and evict the least used facts, pages, and episodes
- [x] Mark recalled and fetched text as untrusted in every prompt and test it against hostile pages
- [ ] Rate-limit background fetches per domain, honour robots.txt, and cap fetches per day
- [ ] Back up, export, and reset the knowledge store, and delete a single fact or memory from the interfaces
- [ ] Let the user mark a recalled fact wrong, lowering its confidence and queueing a recheck
- [ ] Show background job metrics and how often recalled facts are cited in answers
- [x] Take the shared GPU lock in the daemon before loading a model
- [ ] Test schema migrations from every earlier knowledge store version

## in progress

- [ ] Name topics like chat titles and place renamed topics again during consolidation
- [ ] Keep a CPU-only model's context cache and prompt batches off the GPU

## implemented

## tested

## finalized

- [ ]