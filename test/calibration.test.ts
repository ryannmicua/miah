/**
 * U7 calibration bar tests (R74, KTD10, R48; audit U7.8).
 *
 * Covers the bar numbers: corpus >= min_corpus (15), agreement strictly >
 * 14/15, false-blocks <= 2, and the mandatory zero false-pass floor (never
 * configurable); threshold configurability via CalibrationConfig; the
 * operator-supplied profile file at `<base>/calibration/<provider>-<model>.json`;
 * and the default-empty v1 posture (no file -> no verdict authority).
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  CALIBRATION_PROFILE_SCHEMA,
  computeCalibrationMetrics,
  calibrationProfilePath,
  loadCalibrationProfile,
  readCalibrationProfile,
  resolveCalibrationMetrics,
  writeCalibrationProfile,
  type CalibrationCase,
  type CalibrationProfile,
} from "../src/calibration";
import { makeTempDir } from "./helpers";
import { DEFAULT_CONFIG } from "../src/types";

const BAR = DEFAULT_CONFIG.calibration;

function cases(pass: number, falseBlocks = 0, falsePasses = 0): CalibrationCase[] {
  const out: CalibrationCase[] = [];
  for (let i = 0; i < pass; i++) out.push({ label: "pass", verdict: "pass", example: `pass-${i}` });
  for (let i = 0; i < falseBlocks; i++) out.push({ label: "pass", verdict: "fail", example: `block-${i}` });
  for (let i = 0; i < falsePasses; i++) out.push({ label: "fail", verdict: "pass", example: `fp-${i}` });
  return out;
}

function profile(provider: string, model: string, corpus: CalibrationCase[]): CalibrationProfile {
  return {
    schema: CALIBRATION_PROFILE_SCHEMA,
    provider,
    model,
    tiers: { "calibrated-judge": corpus },
  };
}

describe("calibration", () => {
  it("clears the R74 bar with corpus >= 15 and full agreement (U7.8)", () => {
    const metrics = computeCalibrationMetrics("opencode", "glm-5.2", "calibrated-judge", cases(15), BAR);
    expect(metrics.corpus).toBe(15);
    expect(metrics.agreement).toBe(1);
    expect(metrics.false_blocks).toBe(0);
    expect(metrics.false_passes).toBe(0);
    expect(metrics.bar_cleared).toBe(true);
  });

  it("does not clear the bar below min_corpus (14 cases) (R74)", () => {
    const metrics = computeCalibrationMetrics("opencode", "glm-5.2", "calibrated-judge", cases(14), BAR);
    expect(metrics.corpus).toBe(14);
    expect(metrics.bar_cleared).toBe(false);
  });

  it("requires agreement strictly greater than 14/15 (R74)", () => {
    // 14/15 agreement exactly (one false-block) is NOT > 14/15.
    const metrics = computeCalibrationMetrics("opencode", "glm-5.2", "calibrated-judge", cases(14, 1), BAR);
    expect(metrics.corpus).toBe(15);
    expect(metrics.agreement).toBeCloseTo(14 / 15, 12);
    expect(metrics.false_blocks).toBe(1);
    expect(metrics.bar_cleared).toBe(false);
  });

  it("caps false-blocks at max_false_blocks (R74)", () => {
    // 46 cases, 3 false-blocks: agreement 43/46 > 14/15, corpus >= 15, but
    // 3 > max_false_blocks=2 -> bar not cleared.
    const metrics = computeCalibrationMetrics("opencode", "glm-5.2", "calibrated-judge", cases(43, 3), BAR);
    expect(metrics.corpus).toBe(46);
    expect(metrics.agreement).toBeGreaterThan(BAR.min_agreement);
    expect(metrics.false_blocks).toBe(3);
    expect(metrics.bar_cleared).toBe(false);
  });

  it("enforces the mandatory zero false-pass floor even when every other bar is met (R74)", () => {
    // 16 cases, 1 false-pass: agreement 15/16 > 14/15, false-blocks 0, but
    // false_passes === 1 -> the non-relaxable floor fails the bar.
    const metrics = computeCalibrationMetrics("opencode", "glm-5.2", "calibrated-judge", cases(15, 0, 1), BAR);
    expect(metrics.corpus).toBe(16);
    expect(metrics.agreement).toBeGreaterThan(BAR.min_agreement);
    expect(metrics.false_blocks).toBe(0);
    expect(metrics.false_passes).toBe(1);
    expect(metrics.zero_false_pass_floor).toBe(true);
    expect(metrics.bar_cleared).toBe(false);
  });

  it("the zero false-pass floor cannot be disabled through the config (mandatory, R74)", () => {
    // Even a config that pretends to relax it keeps the floor enforced.
    const relaxedBar = { ...BAR, zero_false_pass: false };
    const metrics = computeCalibrationMetrics("opencode", "glm-5.2", "calibrated-judge", cases(15, 0, 1), relaxedBar);
    expect(metrics.bar_cleared).toBe(false);
  });

  it("thresholds are configurable (min_corpus / min_agreement / max_false_blocks, R74)", () => {
    const loose = { ...BAR, min_corpus: 10, min_agreement: 0.5, max_false_blocks: 4 };
    const clears = computeCalibrationMetrics("opencode", "glm-5.2", "calibrated-judge", cases(10), loose);
    expect(clears.bar_cleared).toBe(true);
    // Same 10-case corpus fails the DEFAULT bar (min_corpus 15).
    const defaults = computeCalibrationMetrics("opencode", "glm-5.2", "calibrated-judge", cases(10), BAR);
    expect(defaults.bar_cleared).toBe(false);
    // And a 4-false-block corpus passes the loose cap but fails the default cap.
    const fourBlocks = computeCalibrationMetrics("opencode", "glm-5.2", "calibrated-judge", cases(40, 4), loose);
    expect(fourBlocks.bar_cleared).toBe(true);
  });

  it("the profile file lives at <base>/calibration/<provider>-<model>.json (KTD10)", () => {
    const base = makeTempDir();
    const written = writeCalibrationProfile(base, profile("opencode", "glm-5.2", cases(15)));
    expect(path.dirname(written)).toBe(path.join(base, "calibration"));
    expect(path.basename(written)).toBe("opencode-glm-5.2.json");
    expect(loadCalibrationProfile(base, "opencode", "glm-5.2")).not.toBeNull();
  });

  it("sanitizes provider/model path separators in the calibration filename", () => {
    const base = makeTempDir();
    const written = writeCalibrationProfile(base, profile("opencode", "opencode-go/deepseek-v4-flash", cases(15)));
    expect(path.basename(written)).toBe("opencode-opencode-go_deepseek-v4-flash.json");
    expect(loadCalibrationProfile(base, "opencode", "opencode-go/deepseek-v4-flash")).not.toBeNull();
  });

  it("an absent profile file grants no verdict authority (default-empty v1, R48/KTD10)", () => {
    const base = makeTempDir();
    const metrics = resolveCalibrationMetrics("opencode", "glm-5.2", "calibrated-judge", BAR, base);
    expect(metrics).toBeNull();
    expect(loadCalibrationProfile(base, "opencode", "glm-5.2")).toBeNull();
  });

  it("a written profile resolves to cleared metrics for the matching triple (R48)", () => {
    const base = makeTempDir();
    writeCalibrationProfile(base, profile("opencode", "glm-5.2", cases(15)));
    const metrics = resolveCalibrationMetrics("opencode", "glm-5.2", "calibrated-judge", BAR, base);
    expect(metrics).not.toBeNull();
    expect(metrics?.bar_cleared).toBe(true);
  });

  it("a malformed profile file is treated as absent (fail-closed, R48)", () => {
    const base = makeTempDir();
    const filePath = calibrationProfilePath(base, "opencode", "glm-5.2");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Bad JSON.
    fs.writeFileSync(filePath, "{ not json", "utf8");
    expect(readCalibrationProfile(filePath)).toBeNull();
    // Valid JSON, wrong schema.
    fs.writeFileSync(filePath, '{"schema":"other","provider":"opencode","model":"glm-5.2"}', "utf8");
    expect(readCalibrationProfile(filePath)).toBeNull();
  });

  it("per-tier corpora are judged independently", () => {
    const p: CalibrationProfile = {
      schema: CALIBRATION_PROFILE_SCHEMA,
      provider: "opencode",
      model: "glm-5.2",
      tiers: { "calibrated-judge": cases(15), human: cases(3) },
    };
    const base = makeTempDir();
    writeCalibrationProfile(base, p);
    // The 15-case calibrated-judge corpus clears; the 3-case human corpus does not.
    const judge = resolveCalibrationMetrics("opencode", "glm-5.2", "calibrated-judge", BAR, base);
    expect(judge?.bar_cleared).toBe(true);
    const human = resolveCalibrationMetrics("opencode", "glm-5.2", "human", BAR, base);
    expect(human?.bar_cleared).toBe(false);
  });
});
