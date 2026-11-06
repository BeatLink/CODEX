# Goal

Codex is a harness for running small local LLMs as personal assistants on consumer computers. It aims to let them punch far above their weight in capability, reasoning, memory and the ability to research and learn.

The method: deterministic harness code externalizes thinking steps (gathering facts, researching, loading/storing/refining memory, review and critique) and runs each as an atomic, independent task. Each task re-prompts the model with a fresh context, dedicated memory and hyperspecific instructions. The combination of model and harness should show emergent reasoning and memory beyond what the model manages alone.

## How these docs are built

These four docs are being distilled one file at a time from `docs/research/`, so future coding agents have the context to implement the harness and test it.

- `0-goal.md`: this file.
- `1-rationale-and-decisions.md`: why the design is the way it is.
- `2-architectural-ideal-and-proposed-features.md`: target design and features, with built/not-built status.
- `3-roadmap.md`: what is left to build and how to measure it.

<<<<<<< HEAD
**Processed so far:** `agent-hierarchy.md`
=======
**Processed so far:** `done-agent-hierarchy.md`, `done-architecture.md`, `done-reactive-assistant.md`, `done-reactive-assistant-status.md`, `done-agents-eval-report.md`, `done-research-4b-model-as-assistant.md`, `done-research-task-decomposition-harnesses.md`, `done-mascot-emotions.md`, `done-research-open-source-tts.md`, `done-core-structure-ideas.md`

All research files are now processed.
>>>>>>> d4db434 (Docs restructuring)

**Pending (later, separate pass):** review the existing codebase to find features and designs already implemented but missing from these docs, and to establish where the project stands and what comes next. Until then, "built" / "not built" statuses come only from the research files and may be stale.
