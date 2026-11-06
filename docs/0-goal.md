# Goal

Codex is a harness for running small local LLMs as personal assistants on consumer computers. It aims to let them punch far above their weight in capability, reasoning, memory and the ability to research and learn.

**Why local and small:** large models need datacenters, which means subscriptions and sending private data away. Small models run on the user's own hardware but have stale knowledge and weak reasoning. The harness is there to close that gap.

**The method:** deterministic harness code externalizes thinking steps (gathering facts, researching, loading/storing/refining memory, review and critique) and runs each as an atomic, independent task. Each task re-prompts the model with a fresh context, dedicated memory, hyperspecific instructions and a scratchpad that carries forward only what later steps need. The combination of model and harness should show emergent reasoning and memory beyond what the model manages alone.

**Learn how to learn, not what to know:** the model's weights supply language and common sense; facts, how-to knowledge and skills live outside it, where they can be researched, checked, updated and corrected. A model taught to search, store and retrieve does not go out of date the day it ships.

**What it should handle:** the user's email, calendar, tasks, bookmarks, notes, files and research: noticing what happens, preparing what is needed, and acting where the user allows.

**The long-range aim:** an always-on assistant whose harness re-prompts one core model for each function a mind needs (perceiving events, storing and recalling memory, prioritizing, reviewing the results of its own actions, setting and pursuing goals, drives, initiative, reflection), learning continuously in idle time.

**Nothing is settled.** The design in docs 1–2 records what is built and why, not a commitment. Any part of the strategy or architecture, including the model, the decomposition method and the memory design, may change when evals show something better.

## The docs

- `0-goal.md`: this file.
- `1-rationale-and-decisions.md`: why the design is the way it is, and the options still open.
- `2-architectural-ideal-and-proposed-features.md`: target design and features, with built/not-built status.
- `3-roadmap.md`: what is left to build and how to measure it.

They were distilled from the research notes and design conversations kept in `docs/done/`, and from the old `TODO.md` (see git history). Built/not-built statuses were checked against the code on 2026-11-06; the roadmap says what remains unchecked.
