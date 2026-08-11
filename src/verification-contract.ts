/**
 * Verification-contract machine helpers (KTD1, R8-R11, R15).
 *
 * The parsed verification contract lives on `PlanUnit.verificationContract`
 * (units.json, persisted from the immutable plan snapshot at admission). This
 * module owns normalization (for equality/hashing), the production command
 * seam `verificationCommandsFor`, and the contract-shape predicates used by
 * amendment diffing.
 *
 * Normalization is order-insensitive: command lists, criterion-map keys,
 * per-criterion command lists, and evidence-source lists are all sorted so
 * that a contract whose whitespace or declaration order changed is still the
 * same contract (KTD1: "Normalize ordering for equality and hashing").
 */
import type { CriterionMapping, PlanUnit, VerificationCommand, VerificationContract } from "./types";

/** Sort a string list in place and return it. */
function sorted(values: string[]): string[] {
  return [...values].sort();
}

/**
 * A canonical, order-insensitive form of a contract. Equal canonical forms
 * compare equal under deep equality, so amendment diffing never flags a
 * whitespace/order-only edit as a scope change.
 */
export function normalizeContract(contract: VerificationContract): VerificationContract {
  const commands: VerificationCommand[] = [...contract.commands].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const criterion_map: Record<string, CriterionMapping> = {};
  for (const criterionId of Object.keys(contract.criterion_map).sort()) {
    const mapping = contract.criterion_map[criterionId];
    criterion_map[criterionId] = {
      commands: sorted(mapping.commands),
      evidence_sources: sorted(mapping.evidence_sources),
    };
  }
  return { commands, criterion_map };
}

/** True when two contracts are equivalent up to ordering/whitespace (KTD1). */
export function contractsEqual(
  a: VerificationContract | null | undefined,
  b: VerificationContract | null | undefined,
): boolean {
  if (a === null || a === undefined) {
    return b === null || b === undefined;
  }
  if (b === null || b === undefined) {
    return false;
  }
  return JSON.stringify(normalizeContract(a)) === JSON.stringify(normalizeContract(b));
}

/**
 * The production command seam (R15): the sensor's commands are sourced from
 * the unit's parsed frozen verification contract, in declared order, never
 * from a runtime default. A unit without a parsed contract yields no
 * commands; callers that must not run an implicit zero-command contract
 * (admission, resume) fail closed on the contract's absence instead.
 */
export function verificationCommandsFor(unit: PlanUnit): string[] {
  return (unit.verificationContract?.commands ?? []).map((command) => command.command);
}

/** True when the unit carries a parsed, non-empty verification contract (R10). */
export function hasValidContract(unit: PlanUnit): boolean {
  const contract = unit.verificationContract;
  return contract !== null && contract !== undefined && contract.commands.length > 0;
}
