import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { PlanParseError, parsePlan } from "../src/parser";

const FIXTURES = path.join(__dirname, "fixtures");
const PLAN_FIXTURE = path.join(FIXTURES, "valid-plan.md");

/** Minimal CE plan with the given unit sections joined together. */
function planWithSections(sections: string[], frontmatter = ""): string {
  const header =
    frontmatter ||
    `---\ntitle: Inline Plan\ntype: feat\nartifact_contract: ce-unified-plan/v1\nexecution: code\n---`;
  return `${header}\n\n# Inline Plan\n\n## Implementation Units\n\n${sections.join(
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
    lines.push(`- **depends-on:** ${opts.dependsOn.length === 0 ? "none" : opts.dependsOn.join(", ")}`, "");
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

describe("parser", () => {
  it("parses a valid CE plan fixture into a units.json-shaped structure keyed by U-ID", () => {
    const planText = fs.readFileSync(PLAN_FIXTURE, "utf8");
    const plan = parsePlan(planText);

    expect(plan.title).toBe("Valid Miah Test Plan");
    expect(plan.artifactContract).toBe("ce-unified-plan/v1");
    expect(plan.execution).toBe("code");
    expect(plan.unitIds).toEqual(["U1", "U2", "U3"]);
    expect(plan.duplicateIds).toEqual([]);

    expect(Object.keys(plan.units)).toEqual(["U1", "U2", "U3"]);

    const u1 = plan.units.U1;
    expect(u1.id).toBe("U1");
    expect(u1.number).toBe(1);
    expect(u1.title).toBe("Source module");
    expect(u1.goal).toContain("src/hello.ts");
    expect(u1.creates).toEqual(["src/hello.ts"]);
    expect(u1.inputs).toEqual([]);
    expect(u1.dependsOn).toEqual([]);
    expect(u1.acceptance).toHaveLength(2);
    expect(u1.acceptance?.[0].tier).toBe("deterministic");

    const u2 = plan.units.U2;
    expect(u2.dependsOn).toEqual(["U1"]);
    expect(u2.inputs).toEqual(["src/hello.ts"]);
    expect(u2.acceptance).toHaveLength(2);
    expect(u2.acceptance?.[1].tier).toBe("calibrated-judge");

    const u3 = plan.units.U3;
    expect(u3.creates).toEqual(["config/app.json"]);
    expect(u3.dependsOn).toEqual([]);
  });

  it("preserves per-criterion tiers and strips the tier marker from the criterion text", () => {
    const plan = parsePlan(
      planWithSections([
        unit("1", {
          creates: "none",
          inputs: "none",
          dependsOn: [],
          acceptance: ["`src/hello.ts` exists — `tier: deterministic`", "Reviewer agrees — `tier: calibrated-judge`"],
        }),
      ]),
    );
    const acceptance = plan.units.U1.acceptance;
    expect(acceptance?.[0].text).toBe("`src/hello.ts` exists");
    expect(acceptance?.[0].tier).toBe("deterministic");
    expect(acceptance?.[1].tier).toBe("calibrated-judge");
  });

  it("treats `none` creates/inputs/depends-on as present-but-empty", () => {
    const plan = parsePlan(
      planWithSections([
        unit("1", { creates: "none", inputs: "none", dependsOn: [], acceptance: ["ok — `tier: deterministic`"] }),
      ]),
    );
    const u1 = plan.units.U1;
    expect(u1.creates).toEqual([]);
    expect(u1.inputs).toEqual([]);
    expect(u1.dependsOn).toEqual([]);
  });

  it("marks a missing creates: field as null (a finding, not an empty list)", () => {
    const plan = parsePlan(
      planWithSections([
        unit("1", { inputs: "none", dependsOn: [], acceptance: ["ok — `tier: deterministic`"] }),
      ]),
    );
    expect(plan.units.U1.creates).toBeNull();
  });

  it("marks a missing inputs: field as null (a finding, not an empty list)", () => {
    const plan = parsePlan(
      planWithSections([
        unit("1", { creates: "none", dependsOn: [], acceptance: ["ok — `tier: deterministic`"] }),
      ]),
    );
    expect(plan.units.U1.inputs).toBeNull();
  });

  it("records duplicate U-IDs separately from the units view", () => {
    const plan = parsePlan(
      planWithSections([
        unit("1", { creates: "none", inputs: "none", dependsOn: [], acceptance: ["ok — `tier: deterministic`"] }),
        unit("1", { creates: "none", inputs: "none", dependsOn: [], acceptance: ["dup — `tier: deterministic`"] }),
        unit("2", { creates: "none", inputs: "none", dependsOn: [], acceptance: ["ok — `tier: deterministic`"] }),
      ]),
    );
    expect(plan.duplicateIds).toEqual(["U1"]);
    expect(plan.unitIds).toEqual(["U1", "U2"]);
  });

  it("throws a PlanParseError when the document has no Implementation Units section", () => {
    expect(() => parsePlan("# No units\n\nJust prose.\n")).toThrow(PlanParseError);
  });

  it("throws a PlanParseError on malformed YAML frontmatter", () => {
    expect(() => parsePlan("---\ntitle: [broken\n---\n\n# X\n\n## Implementation Units\n")).toThrow(
      PlanParseError,
    );
  });

  it("handles a document with no frontmatter", () => {
    const plan = parsePlan(
      `# No Frontmatter\n\n## Implementation Units\n\n${unit("1", {
        creates: "none",
        inputs: "none",
        dependsOn: [],
        acceptance: ["ok — `tier: deterministic`"],
      })}\n`,
    );
    expect(plan.title).toBeNull();
    expect(plan.execution).toBeNull();
    expect(plan.unitIds).toEqual(["U1"]);
  });

  it("extracts a unit even when goal and requirements fields are absent", () => {
    const plan = parsePlan(
      planWithSections([
        `### U7. Sparse unit\n\n- **creates:** \`src/sparse.ts\`\n- **inputs:** none\n- **depends-on:** none\n- **Acceptance:**\n  - works — \`tier: human\`\n`,
      ]),
    );
    const u7 = plan.units.U7;
    expect(u7.number).toBe(7);
    expect(u7.goal).toBeNull();
    expect(u7.requirements).toBeNull();
    expect(u7.creates).toEqual(["src/sparse.ts"]);
  });
});
