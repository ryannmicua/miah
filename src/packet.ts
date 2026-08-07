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
 * declared `creates:` paths inside its own worktree; testers/reviewers may not
 * write deliverable code.
 */
export interface AuthorityBounds {
  /** The session is read-only: no writes of files, code, or repo state. */
  read_only: boolean;
  /** Code-writing authority exists for the declared `creates:` paths only. */
  code_writing: boolean;
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
    read_only: role === "planner" || role === "reviewer",
    code_writing: role === "builder",
    scope_change: "prohibited",
    requirement_change: "prohibited",
    acceptance_change: "prohibited",
    recursive_workers: "prohibited",
    run_store_writes: "prohibited",
    worktree_isolation: "mandatory",
    result_contract: "envelope-at-declared-path",
  };
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

/** Render the packet as the prompt handed to the adapter launch (R8-R9). */
export function renderPacketPrompt(packet: DispatchPacket, packetHash: string): string {
  const bounds = packet.authority_bounds;
  const authorityLines = [
    bounds.read_only
      ? "- This session is READ-ONLY: you may not write files, code, or change repository state."
      : "- You may write ONLY inside your own dedicated worktree (worktree isolation is mandatory).",
    bounds.code_writing
      ? "- You have code-writing authority ONLY for the declared `creates:` paths inside your worktree."
      : "- You have NO code-writing authority.",
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
    "",
    "## Plan snapshot excerpt",
    packet.plan_excerpt,
    "",
  ].join("\n");
}

/**
 * Extract the raw `### U<n>. <title>` section of a plan for a unit — the plan
 * excerpt a builder/tester/reviewer receives (R9). Returns null when the unit
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
