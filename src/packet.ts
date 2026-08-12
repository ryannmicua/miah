/**
 * Dispatch packet (R36, U5).
 *
 * The packet is the immutable contract a specialist receives: objective, plan
 * excerpt (the immutable snapshot slice for this unit), the result-envelope
 * output schema, authority bounds, the `creates:`/`inputs:` declaration, and
 * the declared result-envelope path. It is composed from the unit's `units.json`
 * entry (the parsed-once machine view, R24) plus the dispatch's role, take,
 * deadline, and idempotency key.
 *
 * This module is pure: `composePacket` / `computePacketHash` / `renderPacketPrompt`
 * / `extractUnitSection` perform no I/O and hold no run state.
 */
import { computeContentHash } from "./snapshot";
import { PlanUnit, SpecialistRole, UnitId } from "./types";
import { RESULT_ENVELOPE_SCHEMA, type ResultEnvelopeSchema } from "./envelope";

/** Packet version; a change to the shape bumps this. */
export const PACKET_SCHEMA_VERSION = 1;

/**
 * Authority bounds a specialist is subject to (R8-R11). The planner is
 * read-only with no code-writing authority; the builder may write only its
 * declared `creates:` paths inside its own worktree; testers may not write
 * deliverable code; the verifier is read-only except for its declared `.miah`
 * result envelope (KTD3/R13).
 */
export interface AuthorityBounds {
  /** The session is read-only: no writes of files, code, or repo state. */
  read_only: boolean;
  /** Code-writing authority exists for the declared `creates:` paths only. */
  code_writing: boolean;
  /** The only write the session may perform (beyond read-only). */
  envelope_only?: boolean;
  scope_change: "prohibited";
  requirement_change: "prohibited";
  acceptance_change: "prohibited";
  recursive_workers: "prohibited";
  run_store_writes: "prohibited";
  worktree_isolation: "mandatory";
  result_contract: "envelope-at-declared-path";
}

/** Authority bounds for a role (U5 planner/builder test scenario). */
export function authorityBoundsFor(role: SpecialistRole): AuthorityBounds {
  return {
    read_only: role === "planner" || role === "verifier",
    code_writing: role === "builder",
    envelope_only: role === "verifier",
    scope_change: "prohibited",
    requirement_change: "prohibited",
    acceptance_change: "prohibited",
    recursive_workers: "prohibited",
    run_store_writes: "prohibited",
    worktree_isolation: "mandatory",
    result_contract: "envelope-at-declared-path",
  };
}

/**
 * Verifier packet context (KTD3/KTD4, R13): the frozen candidate identity, the
 * evidence package location and seal, the criterion IDs to grade, and the
 * frozen contract summary. The verifier reads the package from its attached
 * workspace and grades exactly these criteria against the sealed evidence.
 */
export interface VerifierPacketContext {
  /** Package directory relative to the worktree root (`.miah/verifier/...`). */
  package_path: string;
  /** The sealed package hash the verifier's v2 envelope must cite (KTD4). */
  package_sha256: string;
  /** The frozen builder attempt this verifier grades (KTD5). */
  candidate_attempt: string;
  /** The frozen builder take this verifier grades (KTD5). */
  candidate_take: number;
  /** The observed builder workspace id (KTD3). */
  workspace_id: string | null;
  /** Criterion IDs with declared tiers, in plan order (KTD1). */
  criteria: Array<{ id: string | null; text: string; tier: string | null }>;
  /** The frozen contract commands (R15). */
  contract_commands: Array<{ id: string; command: string }>;
  /** Human-readable criterion -> commands summary. */
  contract_summary: string;
}

/** The dispatch packet a specialist receives (R36). */
export interface DispatchPacket {
  schema_version: 1;
  packet_type: "miah-dispatch-packet/v1";
  unit_id: UnitId;
  role: SpecialistRole;
  take: number;
  idempotency_key: string;
  deadline: string;
  objective: string;
  /** The immutable plan-snapshot slice for this unit. */
  plan_excerpt: string;
  output_schema: ResultEnvelopeSchema;
  authority_bounds: AuthorityBounds;
  creates: string[];
  inputs: string[];
  /** Result-envelope path relative to the specialist's worktree root (R43). */
  result_envelope_path: string;
  provider: string;
  model: string;
  /** Verifier-only: package, candidate, criteria, and contract context (KTD3). */
  verifier_context?: VerifierPacketContext;
}

export interface ComposePacketInput {
  unit: PlanUnit;
  role: SpecialistRole;
  take: number;
  planExcerpt: string;
  envelopePath: string;
  idempotencyKey: string;
  deadline: string;
  provider: string;
  model: string;
  /** Verifier-only packet context (KTD3/KTD4). */
  verifier?: VerifierPacketContext;
}

/** Compose the dispatch packet from the unit's units.json entry (R24, R36). */
export function composePacket(input: ComposePacketInput): DispatchPacket {
  return {
    schema_version: PACKET_SCHEMA_VERSION,
    packet_type: "miah-dispatch-packet/v1",
    unit_id: input.unit.id,
    role: input.role,
    take: input.take,
    idempotency_key: input.idempotencyKey,
    deadline: input.deadline,
    objective: input.unit.goal ?? input.unit.title,
    plan_excerpt: input.planExcerpt,
    output_schema: RESULT_ENVELOPE_SCHEMA,
    authority_bounds: authorityBoundsFor(input.role),
    creates: input.unit.creates ?? [],
    inputs: input.unit.inputs ?? [],
    result_envelope_path: input.envelopePath,
    provider: input.provider,
    model: input.model,
    ...(input.verifier !== undefined ? { verifier_context: input.verifier } : {}),
  };
}

/** Stable canonical JSON for hashing (sorted keys, no whitespace). */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    );
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 content hash of the packet (R36). Computed over the canonical JSON
 * of the packet so it is deterministic and matches what was actually sent.
 */
export function computePacketHash(packet: DispatchPacket): string {
  return computeContentHash(canonicalJson(packet));
}

/**
 * The output-authority line for the packet prompt: the envelope-only mode
 * (verifier) outranks code-writing authority (builder).
 */
function outputAuthorityLine(
  bounds: DispatchPacket["authority_bounds"],
  packet: DispatchPacket,
): string {
  if (bounds.envelope_only === true) {
    return `- Output authority: the ONLY write you may perform is your result envelope at \`${packet.result_envelope_path}\`; every other write is prohibited.`;
  }
  if (bounds.code_writing) {
    return "- You have code-writing authority ONLY for the declared `creates:` paths inside your worktree.";
  }
  return "- You have NO code-writing authority.";
}

/** Render the packet as the prompt handed to the adapter launch (R8-R9). */
export function renderPacketPrompt(packet: DispatchPacket, packetHash: string): string {
  const bounds = packet.authority_bounds;  const authorityLines = [
    bounds.envelope_only === true
      ? "- This session is READ-ONLY except for the result envelope write below: you may not write any other files, code, or change repository state."
      : bounds.read_only
        ? "- This session is READ-ONLY: you may not write files, code, or change repository state."
        : "- You may write ONLY inside your own dedicated worktree (worktree isolation is mandatory).",
    outputAuthorityLine(bounds, packet),
    "- The plan snapshot is immutable: changing scope, requirements, or acceptance criteria is prohibited.",
    "- Recursively creating other agents is prohibited.",
    "- Writing to the Miah run store is prohibited.",
    `- Result contract: write a single JSON result envelope at \`${packet.result_envelope_path}\` relative to your worktree root, matching the output schema below.`,
  ];
  const createsBlock =
    packet.creates.length > 0
      ? packet.creates.map((entry) => `- \`${entry}\``).join("\n")
      : "- none declared";
  const inputsBlock =
    packet.inputs.length > 0
      ? packet.inputs.map((entry) => `- \`${entry}\``).join("\n")
      : "- none";

  const verifierLines: string[] = [];
  if (packet.verifier_context !== undefined) {
    const context = packet.verifier_context;
    verifierLines.push(
      "",
      "## Verification task (verifier)",
      "",
      "- You grade the frozen builder candidate for this unit against the evidence package.",
      `- Evidence package directory (relative to your worktree root): \`${context.package_path}\` — read it; do not modify it.`,
      `- Evidence package SHA-256 (cite it verbatim in your envelope): \`${context.package_sha256}\``,
      `- Frozen candidate: builder attempt \`${context.candidate_attempt}\`, take ${context.candidate_take}${context.workspace_id !== null ? `, workspace \`${context.workspace_id}\`` : ""}.`,
      "",
      "- Grade EXACTLY these acceptance criteria (stable IDs, declared tiers):",
      ...context.criteria.map(
        (criterion) => `  - ${criterion.id ?? "(no id)"} [${criterion.tier ?? "undeclared"}]: ${criterion.text}`,
      ),
      "",
      "- Frozen verification contract (commands Miah already ran as the sensor; you grade their harvested evidence, you never run them):",
      ...context.contract_commands.map((command) => `  - ${command.id}: \`${command.command}\``),
      "",
      `- Criterion -> command mapping: ${context.contract_summary}`,
      "- Every grade entry: one per criterion, verdict from pass|fail|ungraded, non-empty basis, evidence pointers that resolve to package artifacts whose SHA-256 appears in the custody slice.",
      "- Deterministic criteria: certify from the harvested mechanical evidence (commands all-passed, evidence genuine and complete).",
      "- Judgment criteria: judge from the evidence; your grade carries authority only through the calibration gate Miah applies.",
      "- If a criterion needs human judgment, set flagged_for_human: true instead of forcing a verdict.",
      "- Human-tier criteria are graded by the operator: omit them from your envelope.",
    );
  }

  return [
    "# Miah Dispatch Packet (v1)",
    "",
    `- Role: ${packet.role}`,
    `- Unit: ${packet.unit_id}`,
    `- Take: ${packet.take}`,
    `- Attempt id (idempotency key): ${packet.idempotency_key}`,
    `- Deadline (UTC ISO): ${packet.deadline}`,
    `- Provider/model: ${packet.provider}/${packet.model}`,
    `- Packet hash: ${packetHash}`,
    "",
    "## Objective",
    packet.objective,
    "",
    "## Authority bounds",
    ...authorityLines,
    "",
    "## Deliverables (creates:)",
    createsBlock,
    "",
    "## Inputs (inputs:)",
    inputsBlock,
    "",
    "## Result envelope output schema",
    "```json",
    JSON.stringify(packet.output_schema, null, 2),
    "```",
    ...verifierLines,
    "",
    "## Plan snapshot excerpt",
    packet.plan_excerpt,
    "",
  ].join("\n");
}

/**
 * Extract the raw `### U<n>. <title>` section of a plan for a unit — the plan
 * excerpt a builder/tester/verifier receives (R9). Returns null when the unit
 * heading is absent. The planner receives the full immutable snapshot instead
 * (R8), so dispatch does not call this for the planner role.
 */
export function extractUnitSection(planText: string, unitId: UnitId): string | null {
  const lines = planText.split(/\r?\n/);
  const headingPattern = new RegExp(`^###\\s+${unitId}\\.\\s`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    return null;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^###\s+U\d+\.\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}
