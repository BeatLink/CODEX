# TODO

## postponed

- [ ]

## Planned

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
- [x] Let stage 1 decide whether research is needed instead of keyword regexes
- [x] Let the model write focused search queries instead of reusing the prompt
- [ ] Turn the plan into numbered steps and run each step as its own small call
- [ ] Make the critique mark each requirement pass or fail and revise only what failed, in a bounded loop
- [ ] Add checks that do not rely on the model, such as cited URLs appearing in the evidence
- [ ] Count tokens with the model's tokenizer instead of a characters-per-token estimate
- [ ] Never trim the original request; summarize older stage output instead of cutting it
- [ ] Give each stage its own reply token budget
- [ ] Add an eval harness comparing the bare model with the pipeline on a fixed task set
- [ ] Add schema migrations to the knowledge store
- [ ] Store atomic facts with source URL and confidence instead of one summary per topic
- [ ] Stop copying the topic summary onto every source row
- [ ] Store user memory (preferences, projects, corrections) extracted from each run
- [ ] Store episodic memory of past tasks, plans, and outcomes
- [ ] Retrieve user and episodic memory for every prompt, not only research prompts
- [ ] Place new facts under a parent topic so the topic tree is a real hierarchy
- [ ] Keep a summary on each parent topic built from its children
- [ ] Return a matched fact with its chain of parent summaries during retrieval
- [ ] Record entity relationships from extracted facts in the graph
- [ ] Queue background research from gaps: missed searches, unsupported claims, recurring topics
- [ ] Fetch full pages during background research, not snippets only
- [ ] Merge duplicate facts, flag contradictions, and prune unused facts in the background
- [ ] Track memory usage counts and refresh by usage and staleness
- [ ] Add embedding retrieval with sqlite-vec and combine it with FTS5 ranking
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