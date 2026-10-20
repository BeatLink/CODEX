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