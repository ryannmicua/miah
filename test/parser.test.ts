import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { PlanParseError, parsePlan } from "../src/parser";
import { contractsEqual, verificationCommandsFor } from "../src/verification-contract";

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

describe("verification contract parsing (KTD1)", () => {
  function contractUnit(lines: string[]): string {
    return `### U1. Contract unit\n\n${lines.join("\n")}\n`;
  }

  it("parses explicit U<num>.AC<num> criterion IDs off acceptance bullets", () => {
    const plan = parsePlan(
      planWithSections([
        contractUnit([
          "- **creates:** none",
          "- **inputs:** none",
          "- **depends-on:** none",
          "- **Acceptance:**",
          "  - U1.AC1. `src/hello.ts` exists — `tier: deterministic`",
          "  - U1.AC2. Reviewer agrees — `tier: calibrated-judge`",
        ]),
      ]),
    );
    const acceptance = plan.units.U1.acceptance;
    expect(acceptance?.[0].id).toBe("U1.AC1");
    expect(acceptance?.[0].text).toBe("`src/hello.ts` exists");
    expect(acceptance?.[0].tier).toBe("deterministic");
    expect(acceptance?.[1].id).toBe("U1.AC2");
    expect(acceptance?.[1].text).toBe("Reviewer agrees");
  });

  it("leaves id null when a bullet carries no U<num>.AC<num> prefix", () => {
    const plan = parsePlan(
      planWithSections([
        contractUnit([
          "- **creates:** none",
          "- **inputs:** none",
          "- **depends-on:** none",
          "- **Acceptance:**",
          "  - `src/hello.ts` exists — `tier: deterministic`",
        ]),
      ]),
    );
    expect(plan.units.U1.acceptance?.[0].id).toBeNull();
  });

  it("parses a Verification Contract block into commands, criterion mapping, and evidence sources", () => {
    const plan = parsePlan(
      planWithSections([
        contractUnit([
          "- **creates:** none",
          "- **inputs:** none",
          "- **depends-on:** none",
          "- **Acceptance:**",
          "  - U1.AC1. `src/a.ts` exists — `tier: deterministic`",
          "  - U1.AC2. Reviewer judges the API — `tier: calibrated-judge`",
          "- **Verification Contract:**",
          "  - **Commands:** `U1.CMD1` = `npm test -- test/parser.test.ts`; `U1.CMD2` = `npm run build`",
          "  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`; `U1.AC2` -> `U1.CMD1`, `U1.CMD2`",
          "  - **Evidence sources:** `verification`, changed fixture contents",
        ]),
      ]),
    );
    const contract = plan.units.U1.verificationContract;
    expect(contract).not.toBeNull();
    expect(contract?.commands).toEqual([
      { id: "U1.CMD1", command: "npm test -- test/parser.test.ts" },
      { id: "U1.CMD2", command: "npm run build" },
    ]);
    expect(contract?.criterion_map["U1.AC1"]).toEqual({
      commands: ["U1.CMD1"],
      evidence_sources: ["verification", "changed fixture contents"],
    });
    expect(contract?.criterion_map["U1.AC2"]).toEqual({
      commands: ["U1.CMD1", "U1.CMD2"],
      evidence_sources: ["verification", "changed fixture contents"],
    });
  });

  it("returns an empty contract for a declared block with no parseable sub-bullets", () => {
    const plan = parsePlan(
      planWithSections([
        contractUnit([
          "- **creates:** none",
          "- **inputs:** none",
          "- **depends-on:** none",
          "- **Acceptance:**",
          "  - U1.AC1. `src/a.ts` exists — `tier: deterministic`",
          "- **Verification Contract:**",
        ]),
      ]),
    );
    expect(plan.units.U1.verificationContract).toEqual({ commands: [], criterion_map: {} });
  });

  it("leaves verificationContract null when no block is declared", () => {
    const plan = parsePlan(
      planWithSections([
        contractUnit([
          "- **creates:** none",
          "- **inputs:** none",
          "- **depends-on:** none",
          "- **Acceptance:**",
          "  - U1.AC1. `src/a.ts` exists — `tier: deterministic`",
        ]),
      ]),
    );
    expect(plan.units.U1.verificationContract).toBeNull();
  });

  it("normalizes contracts for equality: order/whitespace changes compare equal, command changes do not", () => {
    const textA = planWithSections([
      contractUnit([
        "- **creates:** none",
        "- **inputs:** none",
        "- **depends-on:** none",
        "- **Acceptance:**",
        "  - U1.AC1. `src/a.ts` exists — `tier: deterministic`",
        "  - U1.AC2. Reviewer agrees — `tier: calibrated-judge`",
        "- **Verification Contract:**",
        "  - **Commands:** `U1.CMD1` = `npm test`; `U1.CMD2` = `npm run build`",
        "  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`; `U1.AC2` -> `U1.CMD2`",
        "  - **Evidence sources:** `verification`",
      ]),
    ]);
    const contractA = parsePlan(textA).units.U1.verificationContract;

    // Same commands and mappings, different declaration order and whitespace.
    const textB = planWithSections([
      contractUnit([
        "- **creates:** none",
        "- **inputs:** none",
        "- **depends-on:** none",
        "- **Acceptance:**",
        "  - U1.AC1. `src/a.ts` exists — `tier: deterministic`",
        "  - U1.AC2. Reviewer agrees — `tier: calibrated-judge`",
        "- **Verification Contract:**",
        "  - **Commands:** `U1.CMD2` = `npm run build` ;  `U1.CMD1` = `npm test`",
        "  - **Criterion mapping:** `U1.AC2` -> `U1.CMD2`; `U1.AC1` -> `U1.CMD1`",
        "  - **Evidence sources:** `verification`",
      ]),
    ]);
    const contractB = parsePlan(textB).units.U1.verificationContract;

    expect(contractsEqual(contractA, contractB)).toBe(true);

    // A command-string change is a real contract change.
    const textC = textA.replace("`npm test`", "`npm test -- changed`");
    const contractC = parsePlan(textC).units.U1.verificationContract;
    expect(contractsEqual(contractA, contractC)).toBe(false);

    // A criterion-mapping change is a real contract change.
    const textD = textA.replace("`U1.AC2` -> `U1.CMD2`", "`U1.AC2` -> `U1.CMD1`");
    const contractD = parsePlan(textD).units.U1.verificationContract;
    expect(contractsEqual(contractA, contractD)).toBe(false);

    // Nulls compare equal to nulls only.
    expect(contractsEqual(null, null)).toBe(true);
    expect(contractsEqual(contractA, null)).toBe(false);
  });

  it("verificationCommandsFor returns parsed snapshot commands in declared order (U1.AC4)", () => {
    const plan = parsePlan(
      planWithSections([
        contractUnit([
          "- **creates:** none",
          "- **inputs:** none",
          "- **depends-on:** none",
          "- **Acceptance:**",
          "  - U1.AC1. `src/a.ts` exists — `tier: deterministic`",
          "- **Verification Contract:**",
          "  - **Commands:** `U1.CMD2` = `npm run build`; `U1.CMD1` = `npm test`",
          "  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`",
          "  - **Evidence sources:** `verification`",
        ]),
      ]),
    );
    expect(verificationCommandsFor(plan.units.U1)).toEqual(["npm run build", "npm test"]);
  });

  it("verificationCommandsFor yields no commands for a contractless unit", () => {
    const plan = parsePlan(
      planWithSections([
        contractUnit([
          "- **creates:** none",
          "- **inputs:** none",
          "- **depends-on:** none",
          "- **Acceptance:**",
          "  - U1.AC1. `src/a.ts` exists — `tier: deterministic`",
        ]),
      ]),
    );
    expect(verificationCommandsFor(plan.units.U1)).toEqual([]);
  });
});
