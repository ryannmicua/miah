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

function unit(
  id: string,
  opts: {
    creates?: string[] | "none";
    inputs?: string[] | "none";
    dependsOn?: string[];
    acceptance?: string[];
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
    for (const criterion of opts.acceptance) {
      lines.push(`  - ${criterion}`);
    }
    lines.push("");
  }
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
