## Residual Review Findings

Source: `ce-code-review` run `20260812-025555` (minimax-m3 audit) on branch `feat/independent-verifier-role` (base `db5cf62`). Scope: independent-verifier-role feature. Findings #1 (P1), #2 (P1), #3 (P2), #6 (P2) were applied in Step 5. The following advisory/follow-up findings were intentionally **not** applied and are deferred. No tracker sink configured; this committed file is the durable record.

- **P2 — #4** `src/step.ts:871-877` — Verifier-attempt budget uses `run.max_takes` as the ceiling; no separate operator-tunable verifier budget. KTD5-settled, flagging for visibility only. Follow-up: add `RunConfig.max_verifier_attempts` (default = `run.max_takes`) so operators tune verifier retries independently of builder takes.
- **P2 — #5** `src/types.ts:443-444` — D8-i defaults collapse tester and verifier onto the same provider/model/role (`opencode`/`glm-5.2`/`audit`). Inert while tester dispatch is unimplemented. Follow-up: give tester its own D8-i row when tester dispatch lands.
- **P3 — #7** `src/types.ts:366` — Verifier-attempt counter is not surfaced in the operator status view or escalation summaries. Follow-up: add `verifier_attempts` to status output and `EscalationSummary`.
- **P3 — #8** `src/step.ts:1145-1155` — Verifier-flag escalations inline the full evidence-pointer array into the `escalation_raised` payload. Journal-size optimization. Follow-up: store evidence pointers as a reference (criterion_id + package pointer) rather than an inline copy; defer until measured.
- **P3 — #9** `src/replay.ts:99` — `roleOf()` defaults unknown role to `builder`; a historical reviewer intent lacking role could replay as a builder termination. Settled KTD5 compatibility decision, flagging for visibility only. Follow-up: prefer a more specific default (e.g., last-role-known) if observed in production; requires user-driven re-replay semantics.

### Residual risks (carried, not findings)

- E2E tests (`test/e2e/full-run.test.ts`, `test/e2e/kill-drill.test.ts`) hang in this environment and were excluded from local runs. A clean `npm test` from a Paseo-equipped host is required before merge (CI will exercise them).
- U7 kill-drill boundary for 'kill after verifier terminal before acceptance' is asserted but not exercised locally.
- Production run-store resume for a legacy contractless unit (KTD1 `scope-change-needed` on resume) is implemented but not exercised by a real persisted contractless run-store locally.

### Source run context

- Branch: `feat/independent-verifier-role`; base: `db5cf62`
- Plan: `docs/plans/2026-08-11-001-feat-independent-verifier-role-implementation-plan.md`
- Review run id: `20260812-025555`; verdict: "Ready with fixes"; 0 settled-conflicts
