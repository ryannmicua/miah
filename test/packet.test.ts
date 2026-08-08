/**
 * U5 packet tests: composePacket, authority bounds, packet hashing, prompt
 * rendering, and unit-section extraction. Pure tests — no store, no adapter.
 */
import { describe, expect, it } from "vitest";
import {
  authorityBoundsFor,
  canonicalJson,
  composePacket,
  computePacketHash,
  extractUnitSection,
  renderPacketPrompt,
} from "../src/packet";
import { defaultEnvelopePath } from "../src/envelope";
import { PlanUnit, SpecialistRole } from "../src/types";

const UNIT_U1: PlanUnit = {
  id: "U1",
  number: 1,
  title: "Source module",
  goal: "Create the src/hello.ts source module.",
  requirements: "R1",
  creates: ["src/hello.ts"],
  inputs: [],
  dependsOn: [],
  acceptance: null,
};

const PLAN_TEXT = [
  "---",
  "title: Test Plan",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Test Plan",
  "",
  "## Implementation Units",
  "",
  "### U1. Source module",
  "",
  "- **Goal:** Create the src/hello.ts source module.",
  "- **creates:** `src/hello.ts`",
  "- **inputs:** none",
  "- **depends-on:** none",
  "",
  "### U2. Consumer module",
  "",
  "- **Goal:** Create the src/greeter.ts consumer module.",
  "- **creates:** `src/greeter.ts`",
  "- **inputs:** `src/hello.ts`",
  "- **depends-on:** U1",
  "",
].join("\n");

function makePacket(role: SpecialistRole = "builder", overrides: Partial<Parameters<typeof composePacket>[0]> = {}) {
  return composePacket({
    unit: UNIT_U1,
    role,
    take: 1,
    planExcerpt: extractUnitSection(PLAN_TEXT, "U1") ?? PLAN_TEXT,
    envelopePath: defaultEnvelopePath(role, "U1", 1),
    idempotencyKey: "dispatch-builder-U1-t1",
    deadline: "2026-08-07T00:00:00.000Z",
    provider: "opencode",
    model: "opencode-go/deepseek-v4-flash",
    ...overrides,
  });
}

describe("dispatch packet", () => {
  it("composes objective, plan excerpt, output schema, authority bounds, creates/inputs, and envelope path", () => {
    const packet = makePacket("builder");
    expect(packet.unit_id).toBe("U1");
    expect(packet.role).toBe("builder");
    expect(packet.take).toBe(1);
    expect(packet.objective).toBe("Create the src/hello.ts source module.");
    expect(packet.plan_excerpt).toContain("### U1. Source module");
    expect(packet.plan_excerpt).toContain("src/hello.ts");
    expect(packet.output_schema.schema).toBe("miah/result-envelope/v1");
    expect(packet.output_schema.fields).toHaveProperty("self_claim");
    expect(packet.creates).toEqual(["src/hello.ts"]);
    expect(packet.inputs).toEqual([]);
    expect(packet.result_envelope_path).toBe(".miah/envelope-builder-U1-t1.json");
    expect(packet.idempotency_key).toBe("dispatch-builder-U1-t1");
    expect(packet.deadline).toBe("2026-08-07T00:00:00.000Z");
  });

  it("planner packet carries the plan snapshot only and NO code-writing authority (R8, U5)", () => {
    const packet = makePacket("planner", {
      planExcerpt: PLAN_TEXT,
      provider: "codex",
      model: "gpt-5.6-sol",
      idempotencyKey: "dispatch-planner-U1-t1",
    });
    // Plan snapshot only: the planner receives the immutable plan text, not a
    // code task, and holds no code-writing authority.
    expect(packet.plan_excerpt).toBe(PLAN_TEXT);
    expect(packet.authority_bounds.read_only).toBe(true);
    expect(packet.authority_bounds.code_writing).toBe(false);
  });

  it("authority bounds are role-appropriate (R8-R11)", () => {
    const planner = authorityBoundsFor("planner");
    expect(planner.read_only).toBe(true);
    expect(planner.code_writing).toBe(false);

    const builder = authorityBoundsFor("builder");
    expect(builder.read_only).toBe(false);
    expect(builder.code_writing).toBe(true);

    const reviewer = authorityBoundsFor("reviewer");
    expect(reviewer.read_only).toBe(true);
    expect(reviewer.code_writing).toBe(false);

    for (const role of ["planner", "builder", "tester", "reviewer"] as const) {
      const bounds = authorityBoundsFor(role);
      expect(bounds.scope_change).toBe("prohibited");
      expect(bounds.recursive_workers).toBe("prohibited");
      expect(bounds.run_store_writes).toBe("prohibited");
      expect(bounds.worktree_isolation).toBe("mandatory");
      expect(bounds.result_contract).toBe("envelope-at-declared-path");
    }
  });

  it("packet hash is a deterministic SHA-256 of the canonical packet (R36)", () => {
    const a = makePacket();
    const b = makePacket();
    expect(computePacketHash(a)).toBe(computePacketHash(b));
    expect(computePacketHash(a)).toMatch(/^[0-9a-f]{64}$/);

    const different = makePacket("builder", { take: 2 });
    expect(computePacketHash(different)).not.toBe(computePacketHash(a));
  });

  it("canonicalJson is key-order independent", () => {
    const left = canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }], z: "s" });
    const right = canonicalJson({ z: "s", a: [1, { c: 3, d: 2 }], b: 1 });
    expect(left).toBe(right);
  });

  it("renderPacketPrompt carries objective, bounds, envelope path, schema, and hash", () => {
    const packet = makePacket("planner", {
      planExcerpt: PLAN_TEXT,
      provider: "codex",
      model: "gpt-5.6-sol",
    });
    const hash = computePacketHash(packet);
    const prompt = renderPacketPrompt(packet, hash);
    expect(prompt).toContain("Miah Dispatch Packet");
    expect(prompt).toContain("## Objective");
    expect(prompt).toContain("Create the src/hello.ts source module.");
    expect(prompt).toContain("## Authority bounds");
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("NO code-writing authority");
    expect(prompt).toContain("result_envelope_path");
    expect(prompt).toContain("## Result envelope output schema");
    expect(prompt).toContain("miah/result-envelope/v1");
    expect(prompt).toContain("## Plan snapshot excerpt");
    expect(prompt).toContain(`Packet hash: ${hash}`);
  });

  it("the packet never carries the base commit (observed, not self-reported, A6)", () => {
    const packet = makePacket();
    expect("base_commit" in packet).toBe(false);
    expect("base_commit" in (packet as unknown as Record<string, unknown>)).toBe(false);
  });

  it("extractUnitSection returns the unit's section and stops at the next heading", () => {
    const section = extractUnitSection(PLAN_TEXT, "U1");
    expect(section).toContain("### U1. Source module");
    expect(section).toContain("Create the src/hello.ts source module.");
    expect(section).not.toContain("### U2. Consumer module");
    expect(section).not.toContain("greeter");
  });

  it("extractUnitSection returns null for an unknown unit", () => {
    expect(extractUnitSection(PLAN_TEXT, "U99")).toBeNull();
  });
});
