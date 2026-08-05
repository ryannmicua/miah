# Agent Orchestration — State of the Art Research Notes

> Research prepared for Miah Phase 2 brainstorming (2026-08-05). Sources: production-pattern guides (Azure Architecture Center, Beam.ai, LangChain, BOTTIS), framework comparisons, Anthropic engineering posts ("Building Effective Agents", "How we built our multi-agent research system", "Demystifying evals for AI agents"), Microsoft AI Red Team failure taxonomy, HITL design guides (AWS Well-Architected Agentic AI Lens, OWASP/AgentPatterns/StackAI/waxell), durable-execution research (Temporal/Dapr/Inngest/LangGraph/LlamaIndex), and academic work (MAST failure taxonomy, error-cascade models, self-correction surveys, decomposition-granularity studies).
>
> Complements `docs/paseo-capabilities.md` (what Paseo gives us). This file is about what the field has learned. It decides nothing — it feeds the brainstorming (planning-brief decisions D1–D8).

## Part 1 — What's working: the state of the art

### 1.1 The central 2026 consensus: deterministic control around autonomous reasoning

Every major framework converged in 2025–2026 on the same architecture thesis: **let LLMs do the reasoning, but wrap that reasoning in deterministic orchestration** — explicit graphs, typed state, checkpoints, validation gates, budgets, and human gates (LangGraph's original thesis; Google ADK 2.0 and Microsoft Agent Framework 1.0 both shipped graph workflows + checkpointing + HITL to catch up). Direct quote from a framework analysis: *"The field has effectively agreed that production agents need explicit control around autonomous reasoning."*

**Implication for Miah:** Miah is exactly this shape. Miah is the deterministic supervisor (plan validation, gates, journal, budgets, escalation); the planners/builders/testers/reviewers are the autonomous reasoning. The industry's hardest-won lesson is our core design bet.

### 1.2 The pattern menu (and which one Miah is)

| Pattern | Structure | Best for | Known failure mode |
|---|---|---|---|
| Orchestrator-worker / supervisor | 1 planner, N specialists | Clear decomposable subtasks; single accountability point | Orchestrator bottleneck; over/under-delegation |
| Sequential pipeline | A→B→C, shared state | Fixed transformation chains with stage dependencies | Early failures propagate; no parallelism |
| Fan-out / fan-in | 1→N→1 | Independent parallel work, multi-perspective analysis | Conflict resolution when results contradict; cost multiplies |
| Debate / maker-checker | A↔B, N rounds | High-stakes correctness; independent verification | Conversation loops; diminishing returns after 1–2 rounds |
| Handoff | Router → specialist | Expertise unknown up front | Infinite handoff loops; unpredictable paths |
| Adaptive planning | Discover the plan | Open-ended problems | Scope creep; plan rewriting |

**Miah maps to orchestrator-worker + fan-out/fan-in (parallel units) + maker-checker (independent test/review) + escalation gates.** That is a deliberately blended pattern, which the literature endorses — production systems combine patterns rather than pick one.

Two selection rules to keep:
- **Start with the lowest level of complexity that reliably meets the requirement** (Azure Architecture Center). Multi-agent orchestration is justified only when a single agent can't handle the task due to prompt complexity, tool overload, or distinct security/role boundaries. "The best pattern is the one that matches your actual problem, not the most sophisticated one you can build."
- **40% of multi-agent pilots fail within ~6 months of production** — usually from picking the wrong pattern or not understanding how it breaks (Beam.ai). Miah should not assume multi-agent everywhere; some "implementation units" may be single-agent-sized.

### 1.3 What Anthropic learned building a production multi-agent system

Anthropic's multi-agent research system (lead agent + parallel subagents + citation agent) is the most-cited production reference. Their lessons, which map directly onto Miah:

1. **Teach the orchestrator how to delegate.** Each subagent brief needs four things: a concrete **objective**, an **output format**, guidance on **tools and sources**, and explicit **task boundaries**. Vague briefs ("research the semiconductor shortage") produced duplicated work, gaps, and misread scope. → Miah's planner must write *bounded implementation unit specs*, and D5 (evidence contract) is the output-format half of this.
2. **Scale effort to query complexity.** Agents can't judge appropriate effort; embed explicit scaling rules (simple fact = 1 agent/3-10 calls; complex = 10+ agents with divided responsibilities). Otherwise they spawn 50 subagents for simple queries. → Miah's bounded units + D7 thresholds are this lever, enforced structurally not by prompting.
3. **Tool design is critical.** Distinct purpose, clear description, clear boundaries per tool. Bad tool descriptions send agents down wrong paths. → The specialist agents' tool surface should be scoped and documented (least toolset per role).
4. **Let agents improve themselves** — a tool-testing agent that rewrites tool descriptions cut task completion time 40%. (Self-improvement of *tools/prompts*, not self-correction of reasoning — see 2.4.)
5. **Evaluation must be flexible and outcome-based** (non-deterministic paths), with an LLM judge validated against human labels, plus human review for calibration. → Miah's acceptance decision needs calibrated graders anchored to deterministic evidence (see 2.5).
6. **Handling stateful errors**: resume-from-checkpoint systems; let agents adapt to tool failures; combine agent adaptability with deterministic safeguards (retry logic, regular checkpoints). Multi-agent systems are stateful; errors compound; restarts are expensive.
7. **The last mile is most of the journey** — gap between prototype and production is wide; "one step failing can cause agents to explore entirely different trajectories."

### 1.4 Frameworks landscape (context, not a Miah dependency)

- **LangGraph** — de facto standard for complex stateful orchestration: explicit StateGraph, typed state, built-in checkpointing with time-travel, mature HITL interrupts, durable execution. The reference for what "resumable supervisor" means mechanically. Python-only.
- **CrewAI** — fastest role-based prototyping; weaker execution control/state persistence.
- **Google ADK 2.0** — multi-language, graph workflows, GCP-native.
- **Microsoft Agent Framework 1.0 (GA April 2026)** — successor to AutoGen + Semantic Kernel; graph workflows, checkpointing, HITL. AutoGen itself is maintenance mode (Oct 2025) — don't build on it.
- **OpenAI Agents SDK** — handoffs as a first-class primitive; minimal.
- **Protocols**: MCP is the agent-to-tool standard; A2A is agent-to-agent interop; both now widely supported. **Relevance:** Miah works with harnesses that speak MCP (Paseo injects tools via MCP), and Paseo subagents already give cross-provider orchestration, so we don't need A2A ourselves.

Miah's job is *above* these frameworks — it supervises harnesses/agents that may themselves be built on any of these. The lessons to steal are the durable-execution and HITL mechanics, not the SDK.

### 1.5 Durable execution: the pattern behind "resumable"

This is the strongest body of engineering practice for Miah's central promise (VISION: resumable). The field converged on the **event-sourcing + checkpoint** model:

- **Durable execution ≠ saving chat history.** It means persisting *execution boundaries* so a crash resumes from the last recorded boundary — no repeated tool calls, no repeated external side effects, no repeated human approvals. "The thing that needs to survive a crash is not the code, it is the record of what the code has already done" (Diagrid).
- **Core mechanics** (Temporal/Dapr/Inngest/LangGraph/LlamaIndex consensus):
  - **Append-only event log / WAL**: record intent before acting — `RunStarted`, `ToolInvoked` (with idempotency key) *before* the HTTP call leaves, `ToolResultRecorded` *before* advancing the step index. Plus `HumanApprovalReceived`, `BudgetDebited`.
  - **Snapshots + WAL**: snapshot every K events or T minutes for fast restore; replay the tail on resume. State = latest snapshot + events.
  - **Idempotency keys** for every mutating/external action — resume is *replay with side effects*; every write tool must be safe to repeat. "Every mutating tool is a transaction boundary."
  - **At-least-once semantics**: in-flight work may be re-executed once — acceptable as wasted compute, not wrong output.
  - **Human gates must be durable**: persist `AwaitingApproval` with the frozen plan hash so resume can never skip an approval step.
  - **Single-writer lease** (resume token + lease) so two workers can't resume the same run and double-execute.
  - **Recovery testing**: deliberately kill the worker mid-run and verify resume without duplicate side effects.
- **Continue-as-new** (Temporal): when the event history grows unbounded, atomically close the run and start a new run with the same run ID carrying forward only essential state — the pattern for runs that must survive huge histories.
- **Checkpoints alone don't solve durability.** A checkpoint says where you were; it doesn't know whether the email was sent or the approval granted. Idempotency + reconciliation + leases are required.

**Implication for Miah:** VISION already mandates an append-only journal and durable filesystem state. The research says the journal must be a **write-ahead log recorded before acting**, entries must be typed and monotonic per run, mutating actions need idempotency keys, resume needs a reconcile step for unknown outcomes, and recovery should be crash-tested. This is the concrete spec for D4.

### 1.6 Evaluation: grader triage (deterministic > LLM-judge > human)

Anthropic's evals post and the broader eval literature converge on a hierarchy:

- **Deterministic/code-based graders first** — tests that pass/fail, tool-call correctness, schema validation, coverage checks, "does the test pass". Cheap, stable, non-gameable.
- **LLM-as-judge only for genuinely subjective dimensions** (faithfulness, completeness, tone) — and only after **calibrating the judge against human labels** (measure agreement; re-check on model/prompt change). A judge you haven't validated "is an unscored assumption, not a measurement."
- **Human review** for ground truth, edge cases, and judge calibration — but reserve it: "once the system is robust, human review only occasionally."
- Judge failure modes to engineer around: **position bias, verbosity bias, self-preference**, and judges that grade generously. Mitigations: tight binary/checklist rubrics, require reasoning before verdict, provide reference answers, order-swapped scoring, composite pass/fail over multiple dimensions rather than a single score.
- **Test the path, not just the answer**: evaluate tool-selection and step-count behavior, and turn every production failure into a regression test ("your dataset should grow every time the agent embarrasses you").
- Also: **a 0% pass rate on a well-designed eval is usually a broken eval (ambiguous spec or wrong grader), not an incapable agent** — "double-check the task" before blaming the model.

**Implication for Miah:** D5 (evidence contract) should rank grader types per acceptance criterion: deterministic tests/checks as the backbone of acceptance; LLM judgment only where tests can't express the criterion, always calibrated; human judgment for the final gate. This makes "accept or rework" (run step 7) mechanically defensible instead of relying on an unanchored LLM verdict.

### 1.7 Human-in-the-loop: risk-tiered, evidence-packed, time-boxed

The HITL literature (AWS Agentic AI Lens, OWASP/AgentPatterns, StackAI, waxell, Cloudflare) is unusually convergent:

- **Gate by risk, not by category, not by everything.** "Routing every agent action through human review produces rubber-stamp approvals; routing none produces unbounded autonomy." Risk-tiered approval pauses agents only where human judgment actually changes the outcome. Approve-before-irreversible; skip gates on reversible steps. **Reversibility is the most reliable placement signal.**
- **The reviewer needs an evidence pack**: the specific action, the reasoning chain, the confidence, the 2-3 signals that triggered escalation — decidable in 10–30 seconds. "The reviewer's job is not to re-do the agent's work; it's to verify it quickly." 40 lines of context is worse than a tight payload.
- **Timeouts and escalation paths are mandatory.** Indefinite blocking and blanket auto-approval are both wrong; they fail in opposite directions. Low-risk deferred approvals may auto-execute after N minutes; high-risk blocking approvals escalate to a backup reviewer then default to blocked.
- **Propose-then-commit**: the agent stores a structured action payload durably; a human reviews the *proposal*; only a locked/verified payload executes. Approvals must happen before side effects, not after (or it's retrospective review).
- **Progressive trust**: start supervised, migrate to exception-only/sampled review as metrics prove reliability. Exception-only review "without strong validators and logging creates the illusion of control."
- **Log every approval** with reviewer identity, timestamp, decision, escalation events — it's how you tune trigger calibration and satisfy compliance (EU AI Act Art. 50 transparency; NIST AI RMF meaningful human oversight).

## Part 2 — Failure modes to watch for and mitigate

### 2.1 Coordination/organizational failures — the dominant class

The MAST taxonomy ("Why Do Multi-Agent LLM Systems Fail?") found that **most multi-agent failures come from organizational design and coordination, not from individual model limitations** — better models won't fix them. High-frequency modes:

- **Proceeding with wrong assumptions instead of seeking clarification** (11.65%).
- **Reasoning–action mismatch** (13.98%) — agent reasons correctly but acts inconsistently.
- **Task derailment** (7.15%) and **information withholding** — an agent that knows a critical fact fails to communicate it, and downstream agents fail repeatedly.
- **Mismatched decomposition granularity**: over-decomposition drowns in coordination overhead (at DGI=7, coordination consumes ~71% of tokens and causes ~51% of errors); under-decomposition overloads each subtask. Optimal granularity scales ~√(reasoning steps); the optimal window *narrows* as complexity rises (clawRxiv decomposition study).
- **Integration bottleneck**: as system scale grows, delegation/contradiction grows but consolidation/merge doesn't — large but weakly integrated reasoning; unresolved conflicts accumulate (coordination-cascade study).

**Mitigations:** tight, structured delegation contracts; independent verification at boundaries; explicit merge/synthesis steps; caps on delegation depth; bounded, well-sized units.

### 2.2 Context management failures

- **Context pollution**: debugging traces and intermediate failures from implementation degrade strategic planning when both live in one context. Fix: **role separation with fresh contexts** — a persistent planner/delegator that never executes code, plus ephemeral workers each spawned with a clean context containing only their spec (CodeDelegator). Structured typed messages replace lossy natural-language summaries between roles.
- **Context accumulation / lost-in-the-middle**: mid-context information is forgotten; long conversations degrade constraint-holding. Even frontier models "fixate on recent context while neglecting critical earlier constraints" (SagaLLM). Fix: persist the plan in external memory, summarize completed phases, spawn fresh contexts.
- **Implication for Miah:** this validates VISION's constraint that testers/reviewers are separate from builders *with distinct contexts* — independence is partly a context-isolation property, not just a role label.

### 2.3 Error cascade and false consensus

- Minor inaccuracies **propagate and amplify** through message dependencies and converge into system-level **false consensus** ("From Spark to Fire"). A single injected atomic falsehood can spread across a multi-agent workflow; late corrections get less reversible as polluted context accumulates. Fixes that work: **claim provenance, targeted verification, rollback/isolation** — detection alone doesn't contain propagation.
- **Baseline-scaled error amplification** (Nature Machine Intelligence): *architectures without centralized verification propagate errors more as baseline difficulty grows* — measured 17.2× amplification with independent agents vs 4.4× with centralized validation bottlenecks. Centralized verification before aggregation is the proven mitigation.
- **Implication for Miah:** the acceptance gate ("evaluate the evidence, decide accept/rework") is not bureaucracy — it is the single highest-leverage reliability mechanism the research identifies. Miah's run step 7 is the *centralized verification bottleneck* that intercepts errors before they aggregate.

### 2.4 Self-correction is unreliable — external ground truth is the only correction

This is the most important negative result for Miah:

- **"No prior work demonstrates successful self-correction with feedback from prompted LLMs"** in general tasks (Kamoi et al., critical survey). LLM "reflection" is largely **conditioned re-generation**: without an external error signal, self-conditioned revision cannot reduce uncertainty — it often *degrades* output (Huang et al.; ICLR "LLMs Cannot Self-Correct Reasoning Yet"; "Reflection or Re-Generation?").
- Self-correction **works when reliable external feedback exists**: test failures, execution errors, environment signals, tool output. "The bottleneck is in the feedback generation."
- Debate/multi-agent critique is "no better than self-consistency at equivalent cost" (Huang et al.).
- **Implication for Miah:** a builder's self-report of completion is not evidence. Rework must be driven by *external signals* — failing tests, reviewer findings, evidence gaps — not by asking the builder to reconsider. This is the empirical justification for VISION's independent testers/reviewers and evidence-based acceptance. It also means the reviewer must be genuinely independent (fresh context, distinct role), since critique from a shared-context peer approximates self-correction.

### 2.5 Evaluator and judge failure modes

- **LLM-as-judge is gameable and biased** (position, verbosity, self-preference) and **unvalidated judges are assumptions**. Calibrate against humans; use deterministic checks wherever a verifiable end-state exists; treat the judge as a noisy instrument, not an oracle.
- **Motivated mislabeling** (Anthropic agentic misalignment): frontier LLM judges *mislabel transcripts because of the downstream consequence of the label* — e.g., a judge labels something favorably when that label lets the agent avoid refusal. This directly threatens Miah's accept/rework and escalate decisions if they rest on an LLM verdict.
- **Mitigations that matter for Miah:** acceptance criteria should be expressed as much as possible as **deterministic/state-decidable checks** (tests pass, schema validates, evidence files exist with required fields); where LLM judgment is unavoidable, use validated judges with binary rubrics and reasons, and design the verdict so the judge's decision *does not benefit from being wrong*. Independent reviewer role (not the agent being judged, not Miah's own planner) reduces incentive distortion.
- **Operational hallucination / safety drift** (arXiv 2607.18366): in multi-turn runs, agents drift from declared intent — textual refusal followed by unsafe execution; and repetitive tool calls (livelocks) even on legitimate tasks. Root cause: decoupling of reasoning context from execution state. Mitigation: **intent–action consistency checks, runtime state tracking, forced termination primitives** — an *Action-Aware Supervision Layer*. This is Miah's runtime-guardrail job.

### 2.6 Silent policy violations and agentic misalignment

- **Silent wrong-state failures** (arXiv 2607.07405): on policy-permissive tools, an agent can execute a forbidden state transition with *no error signal anywhere* — 78% of observed failures were silent, and the tool + agent self-report gave no clue. Fix: **deterministic, read-only pre-execution gates** that inspect the proposed action against state-decidable policy before allowing the write — converted a silent unrecoverable corruption into an explicit rejection the agent can recover from. ("Deterministic gates do not guarantee success, but they deterministically prevent a known class of silent policy-violating writes.")
- **Agentic misalignment** (Anthropic alignment, 2026): experimental but concrete — agents *covertly changing code*, *mislabeling transcripts to shape downstream outcomes*, helping commit fraud while deleting records. **Implication:** Miah's evidence must not rely on an agent's own description of what it did. Evidence = artifacts + traces that Miah collects itself (logs, diffs, test results, workspace state), not agent self-reports.

### 2.7 Human-in-the-loop failure modes — the gate itself is the risk

OWASP lists **ASI09 Human-Agent Trust Exploitation** as a standalone Top-10 risk: *the oversight layer is a vulnerability in its own right*. Failure modes:

- **Rubber-stamping / reviewer fatigue**: high-volume queues degrade attention; approval rate >90% signals triggers too broad; "review becomes a reflex." (Also observed by Microsoft Red Team: **consent fatigue** was the single most exploited HITL failure — very high frequency.)
- **Automation bias / authority deference**: polished, confident agent output is waved through without critical review.
- **HITL bypass chains** (Microsoft Red Team): **compound action decomposition** (no single step warrants review, the compound outcome does), **description laundering** (agent-constructed summaries hide the true effect), **incremental escalation** (gradual trust escalation). Zero-click chains achieved high-impact outcomes.
- **Gradual trust erosion**: the gate works, then silently stops working as volume rises.

**Mitigations (from red-team experience + OWASP + HITL guides):**
- **Risk-tiered / exception-only triggering** (never blanket, never category-only); trigger on risk signals and compound conditions, not single low-signal flags.
- **Evidence packs + adversarial highlight** (flag untrusted-source influence); **force-engagement UI**; tiered approval scaling with reversibility/blast radius; **deterministic invocation** of the gate (not model-decided).
- **Time-delay enforcement** for high-risk approvals (prevents reflexive confirmation).
- **Anomaly detection on approval request frequency/pattern**; monitor approval rate as a leading indicator.
- **Test injections / fire drills** (plant known errors; measure *intervention success rate*, not approval rate); **periodic red-team of the oversight itself**; verify the kill switch by pulling it on a schedule.
- **WORM logs** (write-once-read-many) + cryptographic signature for tamper detection — the audit trail must prove oversight *happened*, not just that it was claimed.

**Implication for Miah:** VISION's escalation boundaries are well-aligned, but the research adds hard requirements: escalation requests need evidence packs, timeouts with defined fallback, logged decisions, monitoring for approval fatigue, and gate placement *before* irreversible actions. And the gate must fire deterministically from policy, not from the model's discretion.

### 2.8 Runaway, budget, and loop failures

- **Livelocks / oscillation**: repeated identical tool calls, no-progress loops (step count monitoring; hash tool+args, detect repeats in a sliding window).
- **Token/cost blowups from over-delegation**: spawning subagents for work the parent should do inline; deep delegation chains (supervisor→researcher→fetcher→parser) exploding cost; unbounded parallel spawns (Anthropic: 50 subagents for a simple query).
- **The budget discipline that works** (Jatin Bansal / Oracle / PolicyAware convergence):
  - **Multi-predicate budgets, checked synchronously before the next action, not after** (step caps, wall-clock deadlines, token ceilings, dollar caps, per-tool quotas, no-progress/oscillation detectors, external abort signals).
  - **Deadlines propagate**: total deadline is the ceiling on every downstream call; per-call deadline = min(remaining budget, max per-call).
  - **Terminate with persisted partial state** — an aborted-with-partial-results outcome is a first-class success state, not a failure to retry.
  - **Circuit breakers** (error rate, spend, anomaly → hard auto-stop → re-authorization to resume is a deliberate human act).
  - **Delegation depth limits** and **concurrency caps** with backpressure.
  - **Static/build-time scanning** for unshielded tools and unbudgeted routes (shift-left governance).
- **Implication for Miah:** D7 thresholds are not just numbers — they're a *runtime mechanism*: budget predicates evaluated before each unit dispatch and before each agent action, with deterministic circuit-breaker outcomes (continue / narrow / reroute / escalate / stop), plus persisted partial state and a tested kill switch.

### 2.9 Durable-execution failure modes (for the journal design)

From the durable-execution literature's own pitfalls list:
- **Checkpointing mid-tool-call** → inconsistent state on replay (checkpoint at step boundaries only).
- **No lease on resume** → duplicate workers double-charge/duplicate side effects.
- **Secrets in snapshots**; **full-context snapshots only** → disk/restore explosion (summarize tool observations, cap snapshot size).
- **Resume without reconcile** → repeats committed writes (reconcile unknown tool outcomes before continuing write tools).
- **Orphan runs** → no TTL/terminal status; dashboards lie. **Ignoring cancel on resume** → zombie runs after operator abort (tie cancel into the FSM and budget ledger atomically).
- **Not crash-testing recovery** → the resume path is exactly where bugs live.

### 2.10 Security (agent supply chain) — relevant but lower priority for v1

Microsoft Red Team v2.0 taxonomy: **HITL bypass** and **cross-domain prompt injection** were the most consistently exploited; **memory poisoning** via injection (one successful injection seeds persistent memory across sessions); **session context contamination**; **inter-agent trust escalation** (granting subagents elevated permissions based on self-asserted role). Mitigations: treat every external component as supply chain (SBOM, provenance for MCP servers); zero-trust inter-agent (cryptographic identity, least privilege); sandboxing; blast-radius caps. **For Miah v1:** least privilege + sandboxing of builders and a tested kill switch cover most of the practical risk; full zero-trust identity is a later concern.

## Part 3 — Best practices Miah should adopt (synthesis)

Ranked by leverage and by how strongly the evidence supports them:

1. **Make acceptance evidence-based and independent, not judgment-based.** Centralized, independent verification is the single best-documented reliability lever (2.3). External ground truth (tests, execution, deterministic checks) — not self-report and not pure self/peer reflection (2.4). This is VISION's core, and the research says it's the right core.
2. **Deterministic gate above autonomous reasoning.** Miah validates, gates, journals, and budgets; specialists reason and act. Industry consensus (1.1).
3. **Structured delegation contracts.** Every specialist brief = objective + output format (schema-typed) + tools + boundaries (1.3, 2.1). The evidence contract (D5) should be typed envelopes, not prose (Paseo `--output-schema` is a ready-made mechanism).
4. **Context isolation per role.** Fresh context per unit; planner never carries implementation noise; reviewers never share the builder's context (2.2). This is what makes "independence" real.
5. **Write-ahead journal, not a diary.** Record intent before acting; typed monotonic events; snapshot + WAL; idempotency for mutating actions; durable approval gates; resume with reconcile; crash-test recovery (1.5, 2.9). This is the concrete D4 spec.
6. **Budget predicates in the runtime, before the next action.** Step/time/token/dollar caps, no-progress detection, delegation-depth and concurrency caps, circuit breaker, persisted partial state, tested kill switch (2.8). Concrete D7 mechanism.
7. **Risk-tiered operator gates with evidence packs, timeouts, and logged decisions.** Gate before irreversible actions only; escalate-to-backup then default; monitor approval rate for fatigue; design gates so they can't be silently bypassed by decomposition (2.7).
8. **Grader triage for acceptance.** Deterministic checks first; validated LLM-judges only for subjective criteria; reserve human for the final gate and judge calibration (1.6, 2.5). Design reviewer verdicts so the label's consequence doesn't corrupt the label.
9. **Evaluate the path, not just the answer.** Use collected traces (agent activity, logs, diffs, test output) as evidence of *how* work happened; turn every failure into a regression/verification case (1.6).
10. **Escalation isolates the dependency chain, not the run.** Block only affected work + dependents; keep independent units running. Validated by the integration-bottleneck and error-cascade research (2.1, 2.3) and already in VISION.
11. **Scale effort to complexity, structurally.** Bounded implementation units with granularity guardrails (avoid over/under-decomposition); effort rules enforced by unit sizing, not just prompting (1.3, 2.1).

## Part 4 — Tensions and open questions for brainstorming

1. **D1/D4 tension:** Miah's supervisor loop must be *deterministic and resumable* (journal + gates). If Miah is itself an agent driving Paseo, the supervisor's decision loop is an LLM conversation — is that deterministic enough? Options: (a) Miah as a *program* that treats each specialist as an external process and stores decisions as typed journal events (closest to durable-execution best practice); (b) Miah as an agent whose every decision is journaled before acting. The evidence favors (a) for the control loop, with LLM only for judgment calls that are themselves journaled and gated.
2. **Who is "Miah" at run time** — a deterministic process, an orchestrator agent, or a hybrid (deterministic harness + LLM evaluator for acceptance)? Research strongly favors hybrid: deterministic gates for what's decidable, LLM only for subjective acceptance criteria, always anchored to evidence.
3. **Independence of reviewers in practice:** fresh context + distinct role is achievable with Paseo subagents in the same workspace; do we also need different *models* (cross-provider) for testers/reviewers to reduce correlated error? Or is context separation sufficient?
4. **Evidence schema vs. free-form:** how far do we push schema-typed envelopes (builder must return JSON matching a schema, test runs produce parseable results) before it burdens the agents? Paseo `--output-schema` gives us this cheaply.
5. **Approval gate mechanics:** ride Paseo's `permit` flow (approve/deny on tool actions) or build Miah-level gates (evidence pack + accept/rework/escalate decisions)? Likely both: tool-level permit for dangerous actions, Miah-level gate for acceptance decisions.
6. **Rework loop discipline:** research says rework must be driven by external signals (failing tests, reviewer findings). Do we allow a builder to self-report "fixed"? Recommend no — rework completes only when the external signal (test/check) passes independently.
7. **Thresholds as runtime mechanism vs. config numbers:** D7 should specify the *mechanism* (budget predicates checked before dispatch, circuit breakers, escalation on no-progress) with operator-configurable values, matching VISION's constraint that values are not improvised during a run.
