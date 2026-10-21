# TODO

## postponed

- [ ]
- [ ] Purge the removed LM Studio notes (`docs/design/lm-studio-models-and-settings.md`, commits 46b2616 and 538c143) from the public history

## Planned

- [x] Work each request as a tree of tasks that the model decides, decomposes, checks, and re-plans
- [ ] Resume an unfinished task tree after the daemon restarts
- [ ] Show each task's result when its row is chosen in the interfaces
- [ ] Subagents / refinement loops
- [ ] Tool calling
- [ ] Web search
- [ ] Local filesystem access
- [ ] Add patch-based edits and Git diff/status tools
- [ ] Add a bounded command runner for targeted checks
- [ ] Iterate code changes from verification failures
- [ ] Add approval gates for consequential actions
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
- [ ] Add an eval harness comparing the bare model with the pipeline on a fixed task set
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
- [ ] Queue background research from unsupported claims and recurring topics
- [x] Fetch full pages during background research, not snippets only
- [x] Merge duplicate facts, flag contradictions, and prune unused facts in the background
- [x] Merge duplicate topics and user memories and re-file topics under better parents in the background
- [x] Track memory usage counts
- [ ] Refresh topics by usage and staleness
- [ ] Add embedding retrieval with sqlite-vec and combine it with FTS5 ranking
- [x] Count recalled memory as evidence in the task tree's URL and value checks, as the pipeline does
- [x] Recall memory for each task's own prompt and search queries, not only once for the whole request
- [x] Rank recalled facts by FTS5 score and term overlap instead of requiring half the prompt's terms
- [ ] Retrieve along the topic tree: pick the best-matching branch, then search only the facts under it
- [ ] Add one-hop graph neighbours of entities named in recalled facts to the remembered context
- [x] Give facts an expiry from their source and recheck them when their topic is refreshed
- [x] Check that an extracted fact's numbers, dates, and distinctive words appear in the source it cites
- [ ] Queue background research from the user's recorded projects
- [ ] Compare differently worded duplicate topics and facts during consolidation, once embeddings exist
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

## in progress

- [ ]

## implemented

- [ ]

## tested

- [ ]

## finalized

- [ ]