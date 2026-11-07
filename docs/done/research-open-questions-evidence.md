# Open questions: published evidence

A digest of published evidence on the nine open strategic questions in [doc 2](../2-open-questions-and-approaches.md). Dated 2026-11-07. No new eval runs.

**Method and limits.** The sources were found by web search on 2026-11-07 and read as abstracts and result summaries, not full papers. Exact figures are indicative. A figure marked "unverified" was seen only in a secondary summary, an aggregator or a 2026 preprint, or the venue could not be confirmed. **Why:** a number copied from a summary can differ from the paper, and a recent preprint has had little review.

Each question ends with a verdict: either "settled enough by prior work to recommend now" or "needs a local test". A recommendation stands until the user accepts it or a Codex eval contradicts it (doc 2 settles questions by Codex's own evals).

## 1. Who plans

- **MAKER**, "Solving a Million-Step LLM Task with Zero Errors", arXiv 2511.09030, Nov 2025. Splits a task into minimal subtasks, votes per subtask with first-to-ahead-by-k, and red-flags suspicious outputs. Solved 20-disk Towers of Hanoi (~1M steps) with zero errors using small non-reasoning models. The log-growth of the vote margin is a theoretical claim; the ~$3,500 gpt-4.1-mini cost is unverified.
- **Agentless**, Xia et al., FSE 2025, arXiv 2407.01489. A fixed localize, repair, validate pipeline scored 32.0% on SWE-bench Lite at ~$0.70 per issue. It was the best open-source system at the time and ahead of autonomous agents.
- **ReWOO**, arXiv 2305.18323: the planner writes the whole plan up front and workers fill in evidence without further LLM calls. It used fewer tokens and scored higher on HotpotQA; a fine-tuned LLaMA 7B planner roughly matched GPT-3.5. **LLMCompiler**, arXiv 2312.04511: a dependency graph with parallel calls (a speed win).
- **PlanCompiler**, arXiv 2604.13092 (unverified, numbers not seen): the LLM picks nodes from a fixed registry and fills parameters, with no LLM calls after the plan.
- **BFCL multi-turn at 4B.** TinyLLM, arXiv 2511.22138: prompt-based Qwen3-4B scored 62.0% overall and 35.25% on multi-turn. Aggregators list Qwen3-4B-Instruct-2507 at ~20-22% on BFCL v4 multi-turn (unverified). **EffGen**, arXiv 2602.00887 (ICML 2026): scores task complexity and routes to a single agent or multi-agent decomposition; the largest gains were on the smallest models (1.5B-32B, 13 benchmarks); numbers not seen.

**Verdict: settled enough by prior work to recommend now.** Up-front plans and fixed pipelines match or beat free agent loops, and the 4B multi-turn numbers say not to let the model plan freely. **Why:** a plan fixed before the run removes the step where a small model drifts. Open only: how many real requests blueprints cover, and the quality of the fallback, decide the planner.

**How to test locally:** log the shape of real requests for a few weeks and count how many a blueprint would match.

## 2. Where reasoning happens

- **Logic-LM**, arXiv 2305.12295: the LLM translates to symbolic form and a solver reasons; +18.4% over chain-of-thought on average in v1, +23.5% in a later version.
- **LINC**, arXiv 2310.15164: helps most for smaller models (StarCoder+); on FOLIO with GPT-4 it is no better than chain-of-thought. **Logic-of-Thought**, arXiv 2409.17539, reports SatLM and LINC below direct prompting in its setup because symbol extraction loses information.
- **Fact extraction is the bottleneck.** A Datalog assistant paper (CEUR Vol-4302, Dec 2025) reports a best extraction F1 of 0.82 with Mistral 3.1 small; one-shot prompting helped a lot. An IJCAI-25 ASP paper reports 90-98% extraction with Llama 3.1 70B. VERUS-LM, arXiv 2501.14540, reports +71% over a GPT-4 baseline on logic puzzles, using solver-error feedback to repair syntax. No Prolog-specific or sub-10B end-to-end numbers were found.
- **Self-verification.** Huang et al., "LLMs Cannot Self-Correct Reasoning Yet", ICLR 2024, arXiv 2310.01798: without external feedback, self-correction often lowers accuracy; it recommends external feedback such as tools. Small models were not studied specifically.

**Verdict: principle settled; extraction needs a local test.** Use rules and external checks for anything checkable, never rely on model self-verification, and keep rules to the user's world, not research text. **Why:** the symbolic gain depends on extraction, and self-correction without feedback is not reliable. Needs a local test: the 4B model's extraction F1 into the rule engine's schema.

**How to test locally:** hand-label 50-100 emails; score per-field F1; compare zero-shot with one-shot and JSON with CSV output.

## 3. Memory shape

- **LongMemEval**, Wu et al., ICLR 2025, arXiv 2410.10813: long-context LLMs drop 30-60% on the 115k-token variant; commercial assistants reach 30-70% on a simpler setting. Session decomposition and time-aware query expansion help retrieval. The five abilities are information extraction, multi-session reasoning, temporal reasoning, knowledge update and abstention.
- **A-MEM**, arXiv 2502.12110: ran Qwen 1.5B/3B and Llama 3.2 1B/3B locally. Qwen2.5-3B used ~1.3k tokens against ~16.9k for the baseline, with F1 gains across LoCoMo categories (numbers approximate; conversational QA only).
- **Mem0 vs Zep/Graphiti are vendor numbers.** Zep reports LongMemEval 71.2% (GPT-4o) with ~1.6k tokens at 2.58 s, against 115k tokens at 28.9 s for full context. Mem0 claims ~93% on LongMemEval and ~92% on LoCoMo (unverified). Zep's LoCoMo score was 75.1 in its own harness and 58.4 in Mem0's rerun, so the harness choice swings results by 15+ points.
- **RAG vs GraphRAG**, Han et al., arXiv 2502.11371: plain RAG wins single-hop detail questions; graph methods (HippoRAG2, community GraphRAG) win multi-hop. Routing between them, or combining them, gave consistent gains.

**Verdict: needs a local test.** Prior work supports retrieval over full context and per-question routing between plain and graph retrieval. Nothing covers a 4B generator reading a structured fact store, and vendor benchmarks are not comparable. **Why:** the unknown is the generator, not the retrieval.

**How to test locally:** build the world model inside the mail pack only; adapt LongMemEval's five abilities to mail; report standard errors.

## 4. Which model and how many

- **Voting.** MAKER shows that votes plus red-flag filters work when steps are tiny and answers countable. "Self-Consistency Is Losing Its Edge", arXiv 2511.00751: diminishing returns for modern models. A GPQA Diamond preprint reports majority voting lowering accuracy for two 7-8B instruct models (preliminary). A test-time-scaling paper, arXiv 2606.28661 (unverified), argues that samples are correlated, so the effective sample count is lower than the nominal one.
- **Cascades.** FrugalGPT, arXiv 2305.05176, matches GPT-4 with up to 98% cost reduction (best case). RouteLLM, ICLR 2025, arXiv 2406.18665: ~85% cost reduction at 95% of GPT-4 quality on MT-Bench (secondary). Both depend on a stable task mix.
- **Survey**, arXiv 2510.03847: small models match or beat larger ones on tool use when guided decoding and schema validation are used, with a large model only for open-ended planning.
- **Benchmarks.** Qwen3.5-4B, self-reported (model-card mirrors, unverified): BFCL-V4 ~50.3, tau2 ~79.9, IFEval ~89.8; no independent reproduction. Phi-4-mini (arXiv 2503.01743): no BFCL or IFEval numbers seen. No Spark-X2.6 data found.

**Verdict: needs a local test, with one recommendation now.** Vote only on discrete control-flow fields (decide, routing, check verdicts), never on free-form writing. **Why:** voting needs countable answers, and its gain is shrinking on modern models. Spark vs Qwen is answerable once the reasoning set runs. Measure specialist cold-load latency before designing a router.

**How to test locally:** the assessment protocol in [doc 3](../3-roadmap.md), "Model choice"; then, if voting is tried, a vote on `decide` alone against the single call.

## 5. How it learns

- **Voyager**, arXiv 2305.16291: removing the skill library makes the agent plateau (~15.3x slower on tech-tree milestones, survey-cited). The verifier is the game's execution feedback.
- **ExpeL**: +18% on ALFWorld and +12% on WebShop over non-adaptive baselines (survey-cited). **HyperSkill**, arXiv 2608.16114 (unverified): Voyager-style and Cheatsheet-style memories fall below no-memory on some settings (-7 to -9 points).
- **Ratchet**, arXiv 2605.22148, and "Library Drift", arXiv 2605.19576 (both unverified preprints): ungated LLM-authored skills add about +0.0 over none; a hygiene or ratchet gate is what makes self-evolving libraries safe.
- **Model collapse** (Curse of Recursion, arXiv 2305.17493; replace-vs-accumulate studies): collapse occurs when a model trains on its own outputs and replaces the original data; accumulating stays stable. This applies to stored memories only by analogy; no direct measurement of agent-memory drift was found.

**Verdict: gate settled; gain needs a local test.** Learned skills help when an external verifier admits them and are neutral or harmful ungated, which supports the non-LLM verifier design. **Why:** every positive result has a verifier in the loop. Needs a local test for the gain from a 4B model's authored rules and skills.

**How to test locally:** no-memory vs gated-memory A/B on a held-out replay set.

## 6. How autonomous

- **AgentDojo**, arXiv 2406.13352 (NeurIPS 2024 datasets track, unverified venue): attacks succeed against the best agents in under 25% of cases; a secondary detector cut that to 8%. In a DeepSeek table undefended attack success was 32.9%; the Tool Filter (restricting available tools to what the task needs) cut it to 0.4%; delimiting only reached 15.3%. PromptArmor, arXiv 2507.15219, lists Tool Filter at 0.79%.
- **InjecAgent**, arXiv 2403.02691 (ACL Findings 2024): 1,054 cases, 30 agents; the GPT-4 agent's attack success was 24%, and 47% with a hacking prompt.
- **Adaptive attacks erode static defenses.** AutoDojo, arXiv 2606.15057 (unverified), recovers 28% against a filter that drives static attack success to 0%. IterInject, arXiv 2605.24659 (unverified), beats all eight defenses tested at over 50%.
- **"Design Patterns for Securing LLM Agents"**, arXiv 2506.08837, and CaMeL: plan-then-execute fixes the tool sequence before untrusted data is read. Injected text can still alter recipients and bodies, so pair it with dual-LLM or code-then-execute.
- **Approval fatigue.** Practitioner sources (unverified) agree that gating everything produces rubber-stamping; set autonomy per action class.

**Verdict: settled enough by prior work to recommend now.** Restrict the tool set per task (the agent server scoping is this defense), fix the plan before untrusted mail is read (blueprints), gate irreversible actions per class, and treat data fencing as weak. **Why:** tool restriction gave the largest measured drop, and fencing the smallest. Needs a local test only for how often the 4B model obeys injected mail text.

**How to test locally:** add injected bodies to the mail replies in `evals/fake_mcp_server.mjs` and count obedience.

## 7. Unit of improvement

- **DSPy docs:** 5-10 training inputs can start; MIPROv2 is recommended with 40+ trials and ~200+ examples to avoid overfitting. **GEPA FAQ** (https://gepa-ai.github.io/gepa/guides/faq): 30-300 examples; works with models as small as Qwen3-4B with the strongest available model as the reflection LM. "GEPA beats MIPROv2 by 10-13%" is secondary (unverified).
- **Miller**, "Adding Error Bars to Evals", arXiv 2411.00640: use paired question-level differences and clustered standard errors (up to 3x naive). Small eval sets give wide intervals; a power analysis decides case counts.

**Verdict: needs a local test, lower priority.** Eval-gated, optimizer-driven changes work in principle, but no source shows a reliable win from a domain-sized past-case set on a 4B model. **Why:** the cited gains come with hundreds of examples and a strong reflection model. Wait until mail has months of recorded outcomes.

**How to test locally:** a paired comparison on replayed cases with a power calculation; anything inside the interval is unproven.

## 8. Persona and conversation

- **Zheng et al.**, "When 'A Helpful Assistant' Is Not Really Helpful", Findings of EMNLP 2024, arXiv 2311.10054: across 2,410 questions, personas gave no overall accuracy gain, and the per-persona effects were random. **Prompting Science Report 4**, arXiv 2512.05858 (Dec 2025): the same for expert personas. Both used larger models; there is no 4B instruction-following evidence.
- **"LLMs Get Lost In Multi-Turn Conversation"**, Laban et al., ICLR 2026, arXiv 2505.06120: a ~39% relative drop (65% vs 90%) from single-turn to multi-turn, mostly from unreliability. It appears even at two turns; recaps or lower temperature do not fix it.

**Verdict: needs a local test.** A persona is probably accuracy-neutral but unmeasured at 4B. Carry a short summary of earlier turns, never raw history. **Why:** multi-turn loss grows with raw history.

**How to test locally:** persona on vs off on the final-answer stage only, scored by schema validity and IFEval-style checks.

## 9. Eval loop

- **tau-bench**, Sierra, ICLR 2025, arXiv 2406.12045: pass^k measures success on all k runs of the same task. GPT-4o scored ~61% pass^1 on retail and under 25% at pass^8.
- **SWE-bench variance study**, arXiv 2602.07150 (unverified preprint): six configurations, ten runs each; single-run pass@1 moves 2.2-6.0 points, and the standard deviation is above 1.5 points even at temperature 0. arXiv 2408.04667: up to 10% accuracy variation over 5 identical runs.
- **Runs needed.** A preprint (preprints.org 202610.0961, unverified) implies 3-8 runs per arm to detect a 0.02 difference. A practitioner post treats a range wider than 1 point over 5 runs as inconclusive.

**Verdict: method settled; variance needs a local test.** Temperature 0 is not enough. Use repeated runs, pass^k and paired per-task differences, and keep per-step metrics (tool-selection accuracy, argument validity) next to end-task success. **Why:** identical runs differ, and one end-task number hides where a step failed. Needs a local test only for the harness's actual variance.

**How to test locally:** run each case ~5 times once, measure the spread, then set the repeat count.

## Closest known work

- **mem-agent** (Dria), https://huggingface.co/blog/driaforall/mem-agent: a 4B model RL-trained to manage markdown memory through Python tools, shipped as an MCP server. Takeaway: a small model can run memory operations but needed training; self-reported.
- **EffGen**, arXiv 2602.00887: small-model agents with complexity-based routing between single and multi-agent execution, prompt compression, MCP and A2A. Takeaway: route by task complexity.
- **smolagents** (Hugging Face): a minimal agent library with simple memory and no vector store. A building block.
- **smolBro**, https://github.com/ramigb/smolBro: a local llama.cpp assistant with SQLite memory, scheduled jobs and MCP, default qwen3:1.7b; early-stage; no model-facing delete. Takeaway: keep deletion out of the model's hands.
- **Hermes Agent** (Nous Research): a third-party guide suggests local Qwen3 4B for routine tasks with a frontier model for hard ones (unverified). Takeaway: an escalation tier is common.
- **Letta, Khoj, Leon, OpenHands small-model experiments:** no sourced information found.

## Summary

| # | Question | Outcome | Key sources |
| --- | --- | --- | --- |
| 1 | Who plans | Decide now | Agentless; MAKER |
| 2 | Where reasoning happens | Decide principle, test extraction | Logic-LM; Huang et al. |
| 3 | Memory shape | Local test | LongMemEval; RAG vs GraphRAG |
| 4 | Which model and how many | Local test | MAKER voting; FrugalGPT |
| 5 | How it learns | Decide gate, test gain | Voyager; Ratchet (unverified) |
| 6 | How autonomous | Decide now, test injection rate | AgentDojo; Design Patterns |
| 7 | Unit of improvement | Local test | DSPy/GEPA; Error Bars |
| 8 | Persona and conversation | Local test | Zheng; Lost in Multi-Turn |
| 9 | Eval loop | Decide method, test variance | tau-bench; SWE-bench variance (unverified) |
