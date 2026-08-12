/**
 * Miah plan preflight (R55-R60).
 *
 * Preflight is a pure function over the plan artifact plus the workspace's
 * current state (R55): it requires no run state, no lease, no dispatched
 * agents, no journal, and no records of prior runs. It performs no I/O; the
 * workspace state is passed in as a list of repo-relative paths.
 *
 * Three check classes (R56):
 *   - structural:    U-IDs present/unique/ascending, depends-on resolves,
 *                    dependency graph acyclic, required fields present,
 *                    every tier is from the D5 ladder
 *   - referential:   inputs resolve to workspace paths or transitive-ancestor
 *                    creates; no cross-unit creates conflicts (R30)
 *   - verifiability: every acceptance criterion declares a tier
 *
 * Severity is block-only (R58): every finding is a refusal.
 */
import { parsePlan } from "./parser";
import { isGradingTier } from "./grading";
import { AcceptanceCriterion, ParsedPlan, PlanUnit, UnitId } from "./types";

/** Check classes (R56). */
export type PreflightClass = "structural" | "referential" | "verifiability";

/** One preflight finding. `unitId` is the offending U-ID, or "plan-level". */
export interface PreflightFinding {
  class: PreflightClass;
  unitId: string;
  code: string;
  message: string;
}

/** A plan-level flag that is not a refusal (e.g. execution-mode flag). */
export interface PreflightFlag {
  code: string;
  message: string;
}

/** Structured preflight verdict (R55). */
export interface PreflightVerdict {
  ok: boolean;
  title: string | null;
  artifactContract: string | null;
  execution: string | null;
  /** Flat list of all findings. */
  failures: PreflightFinding[];
  structural: PreflightFinding[];
  referential: PreflightFinding[];
  verifiability: PreflightFinding[];
  /** Non-blocking flags, e.g. execution-mode flags (admission is separate). */
  flags: PreflightFlag[];
}

/** U-ID for plan-wide findings (R55). */
export const PLAN_LEVEL = "plan-level";

function finding(
  unitId: string,
  class_: PreflightClass,
  code: string,
  message: string,
): PreflightFinding {
  return { class: class_, unitId, code, message };
}

/**
 * Normalize a repo-relative path for comparison: forward slashes, no leading
 * `./`, no trailing slash.
 */
export function normalizeRepoPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.replace(/\/+$/, "");
}

/**
 * Structural preflight (R56(a)).
 *
 * Checks: U-IDs present, unique, ascending (gaps accepted); `depends-on`
 * resolves to real U-IDs; the dependency graph is acyclic; every unit carries
 * an Acceptance block, `creates:` field (R26), and `inputs:` field (R27);
 * every criterion tier is from the D5 ladder (R28).
 */
export function structuralPreflight(plan: ParsedPlan): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const { units, unitIds, duplicateIds } = plan;

  // U-IDs present, unique, ascending (R25, R56(a)).
  if (unitIds.length === 0) {
    findings.push(finding(PLAN_LEVEL, "structural", "no-units", "The plan declares no implementation units."));
  }
  for (const duplicateId of duplicateIds) {
    findings.push(
      finding(duplicateId, "structural", "duplicate-unit-id", `U-ID ${duplicateId} is declared more than once.`),
    );
  }
  let previousNumber = 0;
  for (const id of unitIds) {
    const unit = units[id];
    if (unit === undefined) {
      continue;
    }
    if (previousNumber !== 0 && unit.number <= previousNumber) {
      findings.push(
        finding(
          id,
          "structural",
          "non-ascending-unit-id",
          `U-ID ${id} is not in ascending numeric order (previous: U${previousNumber}).`,
        ),
      );
    }
    previousNumber = unit.number;
  }

  // Required fields per unit (R25, R26, R27, R56(a)).
  for (const id of unitIds) {
    const unit = units[id];
    if (unit === undefined) {
      continue;
    }
    if (unit.acceptance === null) {
      findings.push(
        finding(id, "structural", "missing-acceptance", `Unit ${id} has no Acceptance block.`),
      );
    }
    if (unit.creates === null) {
      findings.push(
        finding(
          id,
          "structural",
          "missing-creates",
          `Unit ${id} does not declare a creates: field (R26).`,
        ),
      );
    }
    if (unit.inputs === null) {
      findings.push(
        finding(id, "structural", "missing-inputs", `Unit ${id} does not declare an inputs: field (R27).`),
      );
    }

    // depends-on resolves to real U-IDs (R25, R56(a)).
    for (const dependency of unit.dependsOn) {
      if (units[dependency] === undefined) {
        findings.push(
          finding(
            id,
            "structural",
            "unresolved-dependency",
            `Unit ${id} depends-on ${dependency}, which is not a declared unit.`,
          ),
        );
      }
    }

    // Every criterion tier is from the D5 ladder (R28, R56(a)).
    for (const criterion of unit.acceptance ?? []) {
      if (criterion.tier !== null && !isGradingTier(criterion.tier)) {
        findings.push(
          finding(
            id,
            "structural",
            "unrecognized-tier",
            `Unit ${id} acceptance criterion has unrecognized tier "${criterion.tier}".`,
          ),
        );
      }
    }

    // Verification contract shape (KTD1, R8-R10): the unit's contract is
    // frozen in the plan snapshot, must be present and non-empty, and must
    // reference only real criteria and commands.
    findings.push(...verificationContractFindings(unit));
  }

  // Acyclic dependency graph (R56(a)). Emit one finding per cycle member so
  // every unit in the cycle is named.
  for (const member of findCycleMembers(plan)) {
    findings.push(
      finding(
        member,
        "structural",
        "cyclic-dependency",
        `Unit ${member} is part of a dependency cycle.`,
      ),
    );
  }

  return findings;
}

/**
 * Verification-contract structural findings for one unit (KTD1, R8-R10).
 *
 * Fail-closed checks, each naming the unit:
 *   - absent `Verification Contract` block        -> missing-verification-contract
 *   - zero total commands                          -> zero-verification-commands
 *   - duplicate command IDs                        -> duplicate-command-id
 *   - acceptance bullets without stable IDs        -> missing-criterion-id
 *   - duplicate criterion IDs                      -> duplicate-criterion-id
 *   - criterion mapping key not in Acceptance      -> unknown-criterion-reference
 *   - mapping references an undeclared command     -> unknown-command-reference
 *   - acceptance criterion absent from the map     -> unmapped-criterion
 *   - deterministic criterion with no command      -> deterministic-criterion-no-command
 *
 * Quality is not scored: presence, references, mapping completeness, and the
 * deterministic-criterion command rule are all that is enforced (KTD1).
 */
export function verificationContractFindings(unit: PlanUnit): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const contract = unit.verificationContract;

  // Acceptance-bullet ID checks are independent of contract presence: every
  // criterion needs a stable ID for the verifier to grade it (KTD1/KTD4).
  const criterionById = new Map<string, AcceptanceCriterion>();
  const criterionIds = new Set<string>();
  for (const criterion of unit.acceptance ?? []) {
    if (criterion.id === null) {
      findings.push(
        finding(
          unit.id,
          "structural",
          "missing-criterion-id",
          `Unit ${unit.id} acceptance criterion "${criterion.text}" has no stable U<num>.AC<num> ID (KTD1).`,
        ),
      );
      continue;
    }
    if (criterionIds.has(criterion.id)) {
      findings.push(
        finding(
          unit.id,
          "structural",
          "duplicate-criterion-id",
          `Unit ${unit.id} declares acceptance criterion ${criterion.id} more than once (KTD1).`,
        ),
      );
    }
    criterionIds.add(criterion.id);
    criterionById.set(criterion.id, criterion);
  }

  if (contract === null || contract === undefined) {
    findings.push(
      finding(
        unit.id,
        "structural",
        "missing-verification-contract",
        `Unit ${unit.id} has no Verification Contract block (R10, KTD1).`,
      ),
    );
    return findings;
  }
  if (contract.commands.length === 0) {
    findings.push(
      finding(
        unit.id,
        "structural",
        "zero-verification-commands",
        `Unit ${unit.id} verification contract declares zero commands (R10, KTD1).`,
      ),
    );
  }

  const commandIds = new Set<string>();
  for (const command of contract.commands) {
    if (commandIds.has(command.id)) {
      findings.push(
        finding(
          unit.id,
          "structural",
          "duplicate-command-id",
          `Unit ${unit.id} verification contract declares command ${command.id} more than once (KTD1).`,
        ),
      );
    }
    commandIds.add(command.id);
  }

  const mappedCriterionIds = new Set<string>();
  for (const [criterionId, mapping] of Object.entries(contract.criterion_map)) {
    mappedCriterionIds.add(criterionId);
    const criterion = criterionById.get(criterionId);
    if (criterion === undefined) {
      findings.push(
        finding(
          unit.id,
          "structural",
          "unknown-criterion-reference",
          `Unit ${unit.id} verification contract maps unknown criterion ${criterionId} (KTD1).`,
        ),
      );
    }
    for (const commandId of mapping.commands) {
      if (!commandIds.has(commandId)) {
        findings.push(
          finding(
            unit.id,
            "structural",
            "unknown-command-reference",
            `Unit ${unit.id} verification contract maps criterion ${criterionId} to undeclared command ${commandId} (KTD1).`,
          ),
        );
      }
    }
    if (criterion !== undefined && criterion.tier === "deterministic" && mapping.commands.length === 0) {
      findings.push(
        finding(
          unit.id,
          "structural",
          "deterministic-criterion-no-command",
          `Unit ${unit.id} deterministic criterion ${criterionId} maps no command (KTD1).`,
        ),
      );
    }
  }

  for (const criterionId of criterionIds) {
    if (!mappedCriterionIds.has(criterionId)) {
      findings.push(
        finding(
          unit.id,
          "structural",
          "unmapped-criterion",
          `Unit ${unit.id} acceptance criterion ${criterionId} is not mapped in the verification contract (KTD1).`,
        ),
      );
    }
  }

  return findings;
}

/**
 * Find all units that participate in a dependency cycle. A unit's
 * `depends-on` edges that do not resolve are ignored (already reported as
 * unresolved-dependency findings).
 */
export function findCycleMembers(plan: ParsedPlan): UnitId[] {
  const { units } = plan;
  const visiting = new Set<UnitId>();
  const visited = new Set<UnitId>();
  const inCycle = new Set<UnitId>();

  const walk = (id: UnitId, stack: UnitId[]): void => {
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    const stackIndex = stack.indexOf(id);
    if (stackIndex >= 0) {
      // Found a cycle: every unit from stackIndex to the end is in it.
      for (const member of stack.slice(stackIndex)) {
        inCycle.add(member);
      }
      visiting.delete(id);
      return;
    }
    const unit = units[id];
    for (const dependency of unit?.dependsOn ?? []) {
      if (units[dependency] === undefined) {
        continue;
      }
      walk(dependency, [...stack, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of plan.unitIds) {
    walk(id, []);
  }
  return [...inCycle];
}

/**
 * Referential preflight (R56(b)).
 *
 * Every path a unit lists in `inputs:` must resolve either to a path present
 * in the workspace at preflight time, or to a path declared in `creates:` of a
 * unit that is a transitive ancestor of the consuming unit in the depends-on
 * closure. Additionally, no two units may declare the same path in `creates:`
 * (cross-unit creates conflict, R30).
 *
 * `workspacePaths` is the repo-relative path set of the workspace at preflight
 * time. The pure function never reads the filesystem itself.
 */
export function referentialPreflight(
  plan: ParsedPlan,
  workspacePaths: string[] = [],
): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const { units, unitIds } = plan;

  const workspaceSet = new Set(workspacePaths.map(normalizeRepoPath));

  // Transitive ancestors per unit (depends-on closure).
  const ancestorCache = new Map<UnitId, Set<UnitId>>();
  const ancestorsOf = (id: UnitId): Set<UnitId> => {
    const cached = ancestorCache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const ancestors = new Set<UnitId>();
    const stack = [...(units[id]?.dependsOn ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() as UnitId;
      if (ancestors.has(next)) {
        continue;
      }
      ancestors.add(next);
      for (const dep of units[next]?.dependsOn ?? []) {
        if (!ancestors.has(dep)) {
          stack.push(dep);
        }
      }
    }
    ancestorCache.set(id, ancestors);
    return ancestors;
  };

  // Maps each creates path to every unit declaring it (R30).
  const createsByPath = new Map<string, UnitId[]>();
  for (const id of unitIds) {
    for (const path of units[id]?.creates ?? []) {
      const normalized = normalizeRepoPath(path);
      const owners = createsByPath.get(normalized) ?? [];
      owners.push(id);
      createsByPath.set(normalized, owners);
    }
  }

  // Cross-unit creates conflicts (R30): one finding per declaring unit.
  for (const [path, owners] of createsByPath) {
    if (owners.length <= 1) {
      continue;
    }
    for (const owner of owners) {
      findings.push(
        finding(
          owner,
          "referential",
          "cross-unit-creates-conflict",
          `Path ${path} is declared in creates: by ${owners.join(" and ")} (R30).`,
        ),
      );
    }
  }

  // Input resolution (R56(b)).
  for (const id of unitIds) {
    const unit = units[id];
    if (unit === undefined || unit.inputs === null) {
      continue;
    }
    const ancestors = ancestorsOf(id);
    const ancestorCreates = new Set<string>();
    for (const ancestor of ancestors) {
      for (const path of units[ancestor]?.creates ?? []) {
        ancestorCreates.add(normalizeRepoPath(path));
      }
    }
    for (const input of unit.inputs) {
      const normalized = normalizeRepoPath(input);
      if (workspaceSet.has(normalized)) {
        continue;
      }
      if (ancestorCreates.has(normalized)) {
        continue;
      }
      findings.push(
        finding(
          id,
          "referential",
          "unresolved-input",
          `Unit ${id} input "${input}" is neither present in the workspace nor created by a transitive ancestor.`,
        ),
      );
    }
  }

  return findings;
}

/**
 * Verifiability preflight (R56(c)).
 *
 * Every acceptance criterion must declare a tier from the D5 ladder so it is
 * gradeable. A criterion with no tier declaration is a verifiability finding.
 */
export function verifiabilityPreflight(plan: ParsedPlan): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const id of plan.unitIds) {
    const unit = plan.units[id];
    if (unit === undefined) {
      continue;
    }
    for (const criterion of unit.acceptance ?? []) {
      if (criterion.tier === null) {
        findings.push(
          finding(
            id,
            "verifiability",
            "missing-tier",
            `Unit ${id} acceptance criterion "${criterion.text}" declares no tier (R56(c)).`,
          ),
        );
      }
    }
  }
  return findings;
}

/**
 * Compose preflight over a plan document (R55, R56). Pure: takes plan text and
 * the workspace's current path set, returns a structured verdict. Produces a
 * plan-level structural finding when the plan cannot be parsed.
 */
export function preflightPlan(planText: string, workspacePaths: string[] = []): PreflightVerdict {
  let plan: ParsedPlan;
  try {
    plan = parsePlan(planText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = finding(PLAN_LEVEL, "structural", "unparseable-plan", message);
    return {
      ok: false,
      title: null,
      artifactContract: null,
      execution: null,
      failures: [failure],
      structural: [failure],
      referential: [],
      verifiability: [],
      flags: [],
    };
  }

  const structural = structuralPreflight(plan);
  const referential = referentialPreflight(plan, workspacePaths);
  const verifiability = verifiabilityPreflight(plan);

  const flags: PreflightFlag[] = [];
  if (plan.execution === "knowledge-work") {
    flags.push({
      code: "execution-knowledge-work",
      message:
        "execution: knowledge-work is out of v1 scope (R22); admission (a separate gate) must reject this plan.",
    });
  }

  const failures = [...structural, ...referential, ...verifiability];
  return {
    ok: failures.length === 0,
    title: plan.title,
    artifactContract: plan.artifactContract,
    execution: plan.execution,
    failures,
    structural,
    referential,
    verifiability,
    flags,
  };
}
