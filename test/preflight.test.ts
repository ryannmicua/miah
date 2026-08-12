import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  PLAN_LEVEL,
  findCycleMembers,
  preflightPlan,
  referentialPreflight,
  structuralPreflight,
  verifiabilityPreflight,
} from "../src/preflight";
import { parsePlan } from "../src/parser";

const FIXTURES = path.join(__dirname, "fixtures");
const VALID_PLAN = path.join(FIXTURES, "valid-plan.md");
const BAD_PLAN = path.join(FIXTURES, "bad-plan.md");

/** Minimal CE plan with the given unit sections joined together. */
function planWithSections(
  sections: string[],
  frontmatter: Record<string, string> = {},
): string {
  const fm: Record<string, string> = {
    title: "Inline Plan",
    type: "feat",
    artifact_contract: "ce-unified-plan/v1",
    execution: "code",
    ...frontmatter,
  };
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n# Inline Plan\n\n## Implementation Units\n\n${sections.join(
    "\n\n",
  )}\n`;
}

/**
 * A criterion bullet with a stable `U<num>.AC<n>.` ID prefix (KTD1). Bullets
 * that already carry an ID prefix are passed through unchanged; the rest get
 * an auto-numbered ID so the emitted plan is contract-valid by default.
 */
function idBullet(unitId: string, index: number, criterion: string): string {
  if (/^U\d+\.AC\d+\s*[.:]\s/.test(criterion)) {
    return criterion;
  }
  return `U${unitId}.AC${index + 1}. ${criterion}`;
}

/**
 * The default Verification Contract block for a unit: one command mapped to
 * every acceptance criterion (KTD1). Pass `contract: "none"` to omit the
 * block, or a raw string to use a custom block verbatim.
 */
function contractBlock(
  unitId: string,
  criteria: string[] | undefined,
  custom: string | "none" | undefined,
): string[] {
  if (custom === "none") {
    return [];
  }
  if (typeof custom === "string") {
    return ["- **Verification Contract:**", ...custom.split("\n")];
  }
  const ids = (criteria ?? []).map((criterion, index) => {
    const prefix = criterion.match(/^U\d+\.AC\d+/);
    return prefix !== null ? prefix[0] : `U${unitId}.AC${index + 1}`;
  });
  return [
    "- **Verification Contract:**",
    "  - **Commands:** `" + `${unitId}.CMD1` + "` = `npm test`",
    "  - **Criterion mapping:** " + ids.map((id) => `\`${id}\` -> \`${unitId}.CMD1\``).join("; "),
    "  - **Evidence sources:** `verification`",
  ];
}

function unit(
  id: string,
  opts: {
    creates?: string[] | "none";
    inputs?: string[] | "none";
    dependsOn?: string[];
    acceptance?: string[];
    /** Custom `Verification Contract` block content, or "none" to omit it. */
    contract?: string | "none";
  } = {},
): string {
  const lines: string[] = [`### U${id}. Test unit ${id}`, "", `- **Goal:** Goal for U${id}.`, ""];
  if (opts.creates !== undefined) {
    const value = opts.creates === "none" ? "none" : opts.creates.map((p) => `\`${p}\``).join(", ");
    lines.push(`- **creates:** ${value}`, "");
  }
  if (opts.inputs !== undefined) {
    const value = opts.inputs === "none" ? "none" : opts.inputs.map((p) => `\`${p}\``).join(", ");
    lines.push(`- **inputs:** ${value}`, "");
  }
  if (opts.dependsOn !== undefined) {
    lines.push(
      `- **depends-on:** ${opts.dependsOn.length === 0 ? "none" : opts.dependsOn.join(", ")}`,
      "",
    );
  }
  if (opts.acceptance !== undefined) {
    lines.push("- **Acceptance:**");
    opts.acceptance.forEach((criterion, index) => {
      lines.push(`  - ${idBullet(id, index, criterion)}`);
    });
    lines.push("");
  }
  lines.push(...contractBlock(id, opts.acceptance, opts.contract));
  return lines.join("\n");
}

/** A well-formed unit declaration (creates + inputs + depends-on + Acceptance). */
function goodUnit(id: string, dependsOn: string[] = [], creates: string[] = [`src/u${id}.ts`]): string {
  return unit(String(id), {
    creates,
    inputs: "none",
    dependsOn,
    acceptance: [`U${id} works — \`tier: deterministic\``],
  });
}

describe("preflight", () => {
  it("valid 3-unit plan returns no failures", () => {
    const planText = fs.readFileSync(VALID_PLAN, "utf8");
    const verdict = preflightPlan(planText);
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
    expect(verdict.structural).toEqual([]);
    expect(verdict.referential).toEqual([]);
    expect(verdict.verifiability).toEqual([]);
    expect(verdict.title).toBe("Valid Miah Test Plan");
    expect(verdict.execution).toBe("code");
  });

  it("valid plan passes referential resolution when inputs are created by an ancestor", () => {
    // U2 inputs src/hello.ts, created by U1 (its direct ancestor).
    const planText = fs.readFileSync(VALID_PLAN, "utf8");
    const verdict = preflightPlan(planText, []);
    expect(verdict.ok).toBe(true);
  });

  it("missing creates: on U2 is a structural failure naming U2", () => {
    const planText = planWithSections([
      goodUnit(1),
      unit("2", { inputs: "none", dependsOn: [], acceptance: ["U2 works — `tier: deterministic`"] }),
    ]);
    const verdict = preflightPlan(planText);
    expect(verdict.ok).toBe(false);
    const missing = verdict.structural.find((f) => f.code === "missing-creates");
    expect(missing).toBeDefined();
    expect(missing?.unitId).toBe("U2");
  });

  it("missing Acceptance block is a structural failure naming the unit", () => {
    const planText = planWithSections([
      unit("1", { creates: "none", inputs: "none", dependsOn: [], acceptance: undefined }),
    ]);
    const verdict = preflightPlan(planText);
    const missing = verdict.structural.find((f) => f.code === "missing-acceptance");
    expect(missing).toBeDefined();
    expect(missing?.unitId).toBe("U1");
  });

  it("cyclic depends-on (U1->U2->U1) is a structural failure naming both", () => {
    const planText = planWithSections([
      goodUnit(1, ["U2"]),
      goodUnit(2, ["U1"]),
    ]);
    const verdict = preflightPlan(planText);
    expect(verdict.ok).toBe(false);
    const cycle = verdict.structural.filter((f) => f.code === "cyclic-dependency");
    expect(cycle.length).toBeGreaterThan(0);
    expect(cycle.map((f) => f.unitId).sort()).toEqual(["U1", "U2"]);
  });

  it("findCycleMembers returns every unit in a cycle", () => {
    const planText = planWithSections([
      goodUnit(1, ["U2"]),
      goodUnit(2, ["U3"]),
      goodUnit(3, ["U1"]),
    ]);
    expect(findCycleMembers(parsePlan(planText)).sort()).toEqual(["U1", "U2", "U3"]);
  });

  it("inputs not created by any transitive ancestor is a referential failure", () => {
    // U2 depends on U1; U1 creates src/u1.ts. U2 inputs src/foo.py, which no
    // ancestor creates and which is not present in the workspace.
    const planText = planWithSections([
      goodUnit(1),
      unit("2", {
        creates: "none",
        inputs: ["src/foo.py"],
        dependsOn: ["U1"],
        acceptance: ["U2 works — `tier: deterministic`"],
      }),
    ]);
    const verdict = preflightPlan(planText, []);
    expect(verdict.ok).toBe(false);
    const unresolved = verdict.referential.filter((f) => f.code === "unresolved-input");
    expect(unresolved.length).toBe(1);
    expect(unresolved[0].unitId).toBe("U2");
  });

  it("inputs resolve to a transitive ancestor's creates even across a chain", () => {
    // U3 depends on U2 depends on U1. U1 creates src/root.ts; U3 inputs it.
    const planText = planWithSections([
      unit("1", { creates: ["src/root.ts"], inputs: "none", dependsOn: [], acceptance: ["ok — `tier: deterministic`"] }),
      goodUnit(2, ["U1"]),
      unit("3", { creates: "none", inputs: ["src/root.ts"], dependsOn: ["U2"], acceptance: ["ok — `tier: deterministic`"] }),
    ]);
    const verdict = preflightPlan(planText, []);
    expect(verdict.ok).toBe(true);
  });

  it("inputs resolve to a path present in the workspace at preflight time", () => {
    const planText = planWithSections([
      unit("1", { creates: "none", inputs: ["src/foo.py"], dependsOn: [], acceptance: ["ok — `tier: deterministic`"] }),
    ]);
    expect(preflightPlan(planText, []).ok).toBe(false);
    expect(preflightPlan(planText, ["src/foo.py"]).ok).toBe(true);
  });

  it("U1 and U3 both declaring the same creates path is a referential failure (R30)", () => {
    const planText = planWithSections([
      unit("1", { creates: ["src/shared.ts"], inputs: "none", dependsOn: [], acceptance: ["ok — `tier: deterministic`"] }),
      goodUnit(2),
      unit("3", { creates: ["src/shared.ts"], inputs: "none", dependsOn: [], acceptance: ["ok — `tier: deterministic`"] }),
    ]);
    const verdict = preflightPlan(planText, []);
    expect(verdict.ok).toBe(false);
    const conflicts = verdict.referential.filter((f) => f.code === "cross-unit-creates-conflict");
    expect(conflicts.map((f) => f.unitId).sort()).toEqual(["U1", "U3"]);
  });

  it("acceptance criterion missing tier is a verifiability failure", () => {
    const planText = planWithSections([
      unit("1", {
        creates: "none",
        inputs: "none",
        dependsOn: [],
        acceptance: ["no tier here"],
      }),
    ]);
    const verdict = preflightPlan(planText);
    expect(verdict.ok).toBe(false);
    const missingTier = verdict.verifiability.filter((f) => f.code === "missing-tier");
    expect(missingTier.length).toBe(1);
    expect(missingTier[0].unitId).toBe("U1");
  });

  it("execution: knowledge-work produces a verdict that flags the mode (admission is a separate gate)", () => {
    const planText = planWithSections([goodUnit(1)], { execution: "knowledge-work" });
    const verdict = preflightPlan(planText);
    expect(verdict.ok).toBe(true); // structurally fine; admission rejects, preflight flags
    expect(verdict.execution).toBe("knowledge-work");
    expect(verdict.flags.some((f) => f.code === "execution-knowledge-work")).toBe(true);
  });

  it("is a pure function: callable with no lease, journal, or run state", () => {
    const planText = fs.readFileSync(VALID_PLAN, "utf8");
    // preflightPlan(planText) needs no store, no state, no side effects beyond
    // the plan string and an optional workspace path list.
    const verdict = preflightPlan(planText, ["some/workspace/path.ts"]);
    expect(verdict.ok).toBe(true);
    // Calling twice yields identical results (pure).
    expect(preflightPlan(planText)).toEqual(verdict);
  });

  it("bad-plan.md returns failures across all three classes, each naming the unit", () => {
    const planText = fs.readFileSync(BAD_PLAN, "utf8");
    const verdict = preflightPlan(planText, []);
    expect(verdict.ok).toBe(false);

    // structural: missing creates on U2, cycle on U4/U5
    expect(verdict.structural.some((f) => f.code === "missing-creates" && f.unitId === "U2")).toBe(true);
    expect(verdict.structural.filter((f) => f.code === "cyclic-dependency").map((f) => f.unitId).sort()).toEqual([
      "U4",
      "U5",
    ]);

    // referential: U2 input not created by ancestor; U1/U3 shared path conflict
    expect(verdict.referential.some((f) => f.code === "unresolved-input" && f.unitId === "U2")).toBe(true);
    expect(verdict.referential.filter((f) => f.code === "cross-unit-creates-conflict").map((f) => f.unitId).sort()).toEqual([
      "U1",
      "U3",
    ]);

    // verifiability: U3 criterion missing tier
    expect(verdict.verifiability.some((f) => f.code === "missing-tier" && f.unitId === "U3")).toBe(true);
  });

  it("unrecognized tier is a structural failure (R28)", () => {
    const planText = planWithSections([
      unit("1", {
        creates: "none",
        inputs: "none",
        dependsOn: [],
        acceptance: ["ok — `tier: bogus-tier`"],
      }),
    ]);
    const verdict = preflightPlan(planText);
    expect(verdict.structural.some((f) => f.code === "unrecognized-tier" && f.unitId === "U1")).toBe(true);
  });

  it("unresolved depends-on is a structural failure naming the unit", () => {
    const planText = planWithSections([goodUnit(1, ["U99"])]);
    const verdict = preflightPlan(planText);
    expect(verdict.structural.some((f) => f.code === "unresolved-dependency" && f.unitId === "U1")).toBe(true);
  });

  it("an unparseable plan yields a plan-level structural failure, not a throw", () => {
    const verdict = preflightPlan("# no units section at all");
    expect(verdict.ok).toBe(false);
    expect(verdict.structural.some((f) => f.unitId === PLAN_LEVEL && f.code === "unparseable-plan")).toBe(true);
  });

  it("pure functions are exported individually and operate on a parsed plan", () => {
    const planText = fs.readFileSync(VALID_PLAN, "utf8");
    const plan = parsePlan(planText);
    expect(structuralPreflight(plan)).toEqual([]);
    expect(referentialPreflight(plan, [])).toEqual([]);
    expect(verifiabilityPreflight(plan)).toEqual([]);
  });
});

describe("verification contract preflight (KTD1, R8-R10)", () => {
  function contractUnit(opts: { mapping: string; commands?: string; evidence?: string }): string {
    const lines = [
      "- **creates:** none",
      "- **inputs:** none",
      "- **depends-on:** none",
      "- **Acceptance:**",
      "  - U1.AC1. `src/a.ts` exists — `tier: deterministic`",
      "  - U1.AC2. Reviewer judges the API — `tier: calibrated-judge`",
      "  - U1.AC3. The operator decides — `tier: human`",
      "- **Verification Contract:**",
      `  - **Commands:** ${opts.commands ?? "`U1.CMD1` = `npm test`"}`,
      `  - **Criterion mapping:** ${opts.mapping}`,
      `  - **Evidence sources:** ${opts.evidence ?? "`verification`"}`,
    ];
    return `### U1. Contract unit\n\n${lines.join("\n")}\n`;
  }

  const VALID_MAPPING =
    "`U1.AC1` -> `U1.CMD1`; `U1.AC2` -> ; `U1.AC3` ->";

  it("a valid mixed-tier contract passes structural preflight", () => {
    const verdict = preflightPlan(
      planWithSections([contractUnit({ mapping: VALID_MAPPING })]),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.structural).toEqual([]);
  });

  it("an absent Verification Contract block is refused and names the unit", () => {
    const planText = planWithSections([
      unit("1", {
        creates: "none",
        inputs: "none",
        dependsOn: [],
        acceptance: ["U1.AC1. works — `tier: deterministic`"],
        contract: "none",
      }),
    ]);
    const verdict = preflightPlan(planText);
    expect(verdict.ok).toBe(false);
    const missing = verdict.structural.filter((f) => f.code === "missing-verification-contract");
    expect(missing.length).toBe(1);
    expect(missing[0].unitId).toBe("U1");
  });

  it("a zero-command contract is refused and names the unit", () => {
    const planText = planWithSections([
      unit("1", {
        creates: "none",
        inputs: "none",
        dependsOn: [],
        acceptance: ["U1.AC1. works — `tier: deterministic`"],
        contract: ["", "  - **Commands:**", "  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`", "  - **Evidence sources:** `verification`"].join("\n"),
      }),
    ]);
    const verdict = preflightPlan(planText);
    expect(verdict.ok).toBe(false);
    const zero = verdict.structural.filter((f) => f.code === "zero-verification-commands");
    expect(zero.length).toBe(1);
    expect(zero[0].unitId).toBe("U1");
    expect(zero[0].message).toContain("U1");
  });

  it("duplicate command IDs are refused", () => {
    const verdict = preflightPlan(
      planWithSections([
        contractUnit({
          mapping: VALID_MAPPING,
          commands: "`U1.CMD1` = `npm test`; `U1.CMD1` = `npm run build`",
        }),
      ]),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.structural.some((f) => f.code === "duplicate-command-id")).toBe(true);
  });

  it("a missing criterion ID is refused", () => {
    const planText = planWithSections([
      [
        "### U1. Idless unit",
        "",
        "- **creates:** none",
        "- **inputs:** none",
        "- **depends-on:** none",
        "- **Acceptance:**",
        "  - works — `tier: deterministic`",
        "- **Verification Contract:**",
        "  - **Commands:** `U1.CMD1` = `npm test`",
        "  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`",
        "  - **Evidence sources:** `verification`",
      ].join("\n"),
    ]);
    const verdict = preflightPlan(planText);
    expect(verdict.ok).toBe(false);
    expect(verdict.structural.some((f) => f.code === "missing-criterion-id")).toBe(true);
  });

  it("duplicate criterion IDs are refused", () => {
    const planText = planWithSections([
      unit("1", {
        creates: "none",
        inputs: "none",
        dependsOn: [],
        acceptance: [
          "U1.AC1. first — `tier: deterministic`",
          "U1.AC1. second — `tier: deterministic`",
        ],
      }),
    ]);
    const verdict = preflightPlan(planText);
    expect(verdict.ok).toBe(false);
    expect(verdict.structural.some((f) => f.code === "duplicate-criterion-id")).toBe(true);
  });

  it("an unknown criterion reference is refused", () => {
    const verdict = preflightPlan(
      planWithSections([
        contractUnit({ mapping: "`U1.AC9` -> `U1.CMD1`; `U1.AC2` -> ; `U1.AC3` ->" }),
      ]),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.structural.some((f) => f.code === "unknown-criterion-reference")).toBe(true);
  });

  it("an unknown command reference is refused", () => {
    const verdict = preflightPlan(
      planWithSections([
        contractUnit({ mapping: "`U1.AC1` -> `U1.CMD9`; `U1.AC2` -> ; `U1.AC3` ->" }),
      ]),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.structural.some((f) => f.code === "unknown-command-reference")).toBe(true);
  });

  it("a deterministic criterion with no mapped command is refused", () => {
    const verdict = preflightPlan(
      planWithSections([
        contractUnit({ mapping: "`U1.AC1` -> ; `U1.AC2` -> ; `U1.AC3` ->" }),
      ]),
    );
    expect(verdict.ok).toBe(false);
    const noCommand = verdict.structural.filter(
      (f) => f.code === "deterministic-criterion-no-command",
    );
    expect(noCommand.length).toBe(1);
    expect(noCommand[0].message).toContain("U1.AC1");
  });

  it("an unmapped acceptance criterion is refused", () => {
    const verdict = preflightPlan(
      planWithSections([
        contractUnit({ mapping: "`U1.AC1` -> `U1.CMD1`; `U1.AC3` ->" }),
      ]),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.structural.some((f) => f.code === "unmapped-criterion")).toBe(true);
  });

  it("historical contractless plans now fail with the new code (KTD1)", () => {
    // A plan in the pre-feature shape: Acceptance bullets with tiers but no
    // stable IDs and no Verification Contract block at all (R8-R10).
    const planText = planWithSections([
      [
        "### U1. Legacy unit",
        "",
        "- **creates:** `src/a.ts`",
        "- **inputs:** none",
        "- **depends-on:** none",
        "- **Acceptance:**",
        "  - `src/a.ts` exists — `tier: deterministic`",
      ].join("\n"),
    ]);
    const verdict = preflightPlan(planText);
    expect(verdict.ok).toBe(false);
    expect(
      verdict.structural.some((f) => f.code === "missing-verification-contract"),
    ).toBe(true);
    expect(verdict.structural.some((f) => f.code === "missing-criterion-id")).toBe(true);
  });
});
