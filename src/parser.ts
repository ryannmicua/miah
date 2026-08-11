/**
 * CE `ce-unified-plan/v1` parser (R22-R30, R24).
 *
 * Parses the plan's YAML frontmatter (`artifact_contract`, `execution`,
 * `title`) and the `## Implementation Units` section, producing the
 * units.json-shaped machine view keyed by U-ID. The journal, dispatcher, and
 * acceptance predicate read this cached view and never re-parse the plan
 * markdown mid-run (parse-once-and-cache principle, R24).
 *
 * This module is pure: it takes plan text and returns a parsed structure. It
 * performs no I/O and holds no run state.
 */
import { parse as parseYaml } from "yaml";
import {
  AcceptanceCriterion,
  CriterionMapping,
  ParsedPlan,
  PlanUnit,
  UnitId,
  VerificationCommand,
  VerificationContract,
} from "./types";

/** Marker for a root unit's dependency list (R25: empty for roots). */
const NONE_TOKEN = "none";

/** Field name -> value delimiter used in each unit's bullet list. */
const FIELD_PATTERN = /^-\s+\*\*(.+?):\*\*\s*(.*)$/;

/** H3 heading for an Implementation Unit: `### U<number>. <title>`. */
const UNIT_HEADING_PATTERN = /^###\s+U(\d+)\.\s+(.+)$/;

/** Frontmatter delimited by `---` lines at the top of the document. */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

/** A backtick-quoted path inside a `creates:` / `inputs:` value. */
const PATH_TOKEN_PATTERN = /`([^`]+)`/g;

/** A U-ID token inside a `depends-on:` value. */
const UNIT_ID_TOKEN_PATTERN = /\bU(\d+)\b/g;

/** An (indented) acceptance criterion bullet inside an `Acceptance` block. */
const CRITERION_PATTERN = /^\s+[-*]\s+(.+)$/;

export class PlanParseError extends Error {}

/**
 * Split the raw plan text into (frontmatter yaml, body). Returns null for the
 * frontmatter when the document does not open with a `---` block.
 */
export function splitFrontmatter(
  planText: string,
): { frontmatterYaml: string | null; body: string } {
  const match = planText.match(FRONTMATTER_PATTERN);
  if (!match) {
    return { frontmatterYaml: null, body: planText };
  }
  return { frontmatterYaml: match[1], body: planText.slice(match[0].length) };
}

/** Extract a scalar string field from parsed frontmatter YAML. */
function yamlString(frontmatter: unknown, key: string): string | null {
  if (typeof frontmatter !== "object" || frontmatter === null) {
    return null;
  }
  const value = (frontmatter as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Collect backtick-quoted paths from a `creates:` / `inputs:` value.
 * A value of `none` (or any value with no path tokens) yields an empty list.
 */
export function parsePathList(value: string): string[] {
  const paths: string[] = [];
  for (const match of value.matchAll(PATH_TOKEN_PATTERN)) {
    paths.push(match[1].trim());
  }
  return paths;
}

/**
 * Collect U-ID tokens from a `depends-on:` value.
 * A value of `none` (or any value with no U-ID tokens) yields an empty list.
 */
export function parseUnitIdList(value: string): UnitId[] {
  const ids: UnitId[] = [];
  for (const match of value.matchAll(UNIT_ID_TOKEN_PATTERN)) {
    ids.push(`U${match[1]}`);
  }
  return ids;
}

/** True when the value explicitly declares "none" (an empty list). */
function isNoneValue(value: string): boolean {
  return value.trim().toLowerCase() === NONE_TOKEN;
}

/**
 * Parse a single unit section's bullet fields into a PlanUnit. Recognized
 * fields: Goal, Requirements, creates:, inputs:, depends-on, Acceptance.
 * Other fields (Files, Approach, Test Scenarios, Verification) are preserved
 * as opaque text within the section but are not extracted as unit metadata.
 */
function parseUnitSection(lines: string[], id: UnitId, number: number, title: string): PlanUnit {
  let goal: string | null = null;
  let requirements: string | null = null;
  let creates: string[] | null = null;
  let inputs: string[] | null = null;
  let dependsOn: UnitId[] = [];
  let acceptance: AcceptanceCriterion[] | null = null;
  let verificationContract: VerificationContract | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const field = line.match(FIELD_PATTERN);
    if (!field) {
      continue;
    }
    const name = field[1].trim();
    const value = field[2].trim();
    switch (name.toLowerCase()) {
      case "goal":
        goal = value || null;
        break;
      case "requirements":
        requirements = value || null;
        break;
      case "creates":
        creates = isNoneValue(value) ? [] : parsePathList(value);
        break;
      case "inputs":
        inputs = isNoneValue(value) ? [] : parsePathList(value);
        break;
      case "depends-on":
        dependsOn = isNoneValue(value) ? [] : parseUnitIdList(value);
        break;
      case "acceptance": {
        const criteria: AcceptanceCriterion[] = [];
        // Acceptance criteria are the indented bullet lines following the
        // field. Non-indented lines (e.g. the next `- **field:**`) end the
        // block.
        let j = i + 1;
        while (j < lines.length) {
          const bullet = lines[j].match(CRITERION_PATTERN);
          if (!bullet) {
            break;
          }
          criteria.push(parseCriterion(bullet[1].trim()));
          j++;
        }
        acceptance = criteria;
        i = j - 1;
        break;
      }
      case "verification contract": {
        const parsed = parseVerificationContract(lines, i + 1);
        verificationContract = parsed.contract;
        i = parsed.nextIndex - 1;
        break;
      }
      default:
        break;
    }
  }

  return {
    id,
    number,
    title,
    goal,
    requirements,
    creates,
    inputs,
    dependsOn,
    acceptance,
    verificationContract,
  };
}

/**
 * Tier marker trailing an acceptance criterion, e.g. `— \`tier: deterministic\``.
 * Anchored at the end so mid-text "tier" mentions (in prose or paths) are not
 * treated as declarations.
 */
const TIER_PATTERN = /(?:[–—-]\s*)?`?tier\s*[:=]\s*`?([A-Za-z][A-Za-z-]*)`?$/i;

/**
 * Explicit stable criterion ID prefix, e.g. `U1.AC1. ` (KTD1). Only this
 * `U<num>.AC<num>.` shape is treated as an ID; anything else leaves `id`
 * null and the criterion unmapped.
 */
const CRITERION_ID_PATTERN = /^U(\d+)\.AC(\d+)\s*[.:]\s+/i;

/** Parse a tier: marker off an acceptance criterion's text (R28, R47). */
export function parseCriterion(text: string): AcceptanceCriterion {
  const idMatch = text.match(CRITERION_ID_PATTERN);
  const id = idMatch !== null ? `U${idMatch[1]}.AC${idMatch[2]}` : null;
  const withoutId = idMatch !== null ? text.slice(idMatch[0].length) : text;
  const tierMatch = withoutId.match(TIER_PATTERN);
  if (!tierMatch) {
    return { id, text: withoutId, tier: null };
  }
  const tier = tierMatch[1].toLowerCase();
  const withoutTier = withoutId.replace(tierMatch[0], "").trim();
  return { id, text: withoutTier || withoutId, tier };
}

/** An indented sub-field bullet inside the Verification Contract block. */
const CONTRACT_SUBFIELD_PATTERN = /^\s+-\s+\*\*(.+?):\*\*\s*(.*)$/;

/** One or more `` `ID` = `command` `` pairs on a Commands line (KTD1). */
const COMMAND_PAIR_PATTERN = /`([^`]+)`\s*=\s*`([^`]+)`/g;

/** A `` `criterion` -> commands... `` chunk on a Criterion mapping line. */
const MAPPING_CHUNK_PATTERN = /`([^`]+)`\s*->\s*(.*)$/;

/** A backtick-quoted token (command IDs in a mapping, sources in evidence). */
const BACKTICK_TOKEN_PATTERN = /`([^`]+)`/g;

/** Parse the command pairs from a Commands line value. */
function parseCommandPairs(value: string): VerificationCommand[] {
  const commands: VerificationCommand[] = [];
  for (const match of value.matchAll(COMMAND_PAIR_PATTERN)) {
    commands.push({ id: match[1].trim(), command: match[2].trim() });
  }
  return commands;
}

/** Parse `critId -> cmd1, cmd2` chunks from a Criterion mapping line value. */
function parseCriterionMappings(value: string): Record<string, CriterionMapping> {
  const criterionMap: Record<string, CriterionMapping> = {};
  for (const chunk of value.split(";")) {
    const match = chunk.trim().match(MAPPING_CHUNK_PATTERN);
    if (match === null) {
      continue;
    }
    const criterionId = match[1].trim();
    const commandIds: string[] = [];
    for (const token of match[2].matchAll(BACKTICK_TOKEN_PATTERN)) {
      commandIds.push(token[1].trim());
    }
    criterionMap[criterionId] = {
      commands: commandIds,
      evidence_sources: [],
    };
  }
  return criterionMap;
}

/** Parse named evidence sources from an Evidence sources line value. */
function parseEvidenceSources(value: string): string[] {
  const sources: string[] = [];
  for (const token of value.replace(/`/g, "").split(/[,;]/)) {
    const trimmed = token.trim();
    if (trimmed.length > 0) {
      sources.push(trimmed);
    }
  }
  return sources;
}

/**
 * Parse a unit's `Verification Contract` block (KTD1): the indented
 * `Commands`, `Criterion mapping`, and `Evidence sources` sub-bullets that
 * follow the field bullet. Returns the parsed contract and the index of the
 * first line after the block.
 *
 * An empty block (declared but with no parseable sub-bullets) yields an
 * empty contract `{commands: [], criterion_map: {}}` so preflight reports
 * `zero-verification-commands` rather than a missing block.
 */
function parseVerificationContract(
  lines: string[],
  start: number,
): { contract: VerificationContract; nextIndex: number } {
  let commands: VerificationCommand[] = [];
  let criterionMap: Record<string, CriterionMapping> = {};
  let evidenceSources: string[] = [];

  let i = start;
  for (; i < lines.length; i++) {
    const sub = lines[i].match(CONTRACT_SUBFIELD_PATTERN);
    if (sub === null) {
      break;
    }
    const name = sub[1].trim().toLowerCase();
    const value = sub[2].trim();
    switch (name) {
      case "commands":
        commands = parseCommandPairs(value);
        break;
      case "criterion mapping":
        criterionMap = parseCriterionMappings(value);
        break;
      case "evidence sources":
        evidenceSources = parseEvidenceSources(value);
        break;
      default:
        break;
    }
  }

  // Named evidence sources are unit-level and copied onto every criterion
  // mapping (KTD1: maps every criterion ID to commands plus named sources).
  for (const mapping of Object.values(criterionMap)) {
    mapping.evidence_sources = [...evidenceSources];
  }

  return { contract: { commands, criterion_map: criterionMap }, nextIndex: i };
}

/**
 * Extract the `## Implementation Units` section body from the plan body.
 * Returns the lines between that H2 heading and the next H2 heading.
 */
export function extractImplementationUnitsSection(body: string): string[] | null {
  const lines = body.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Implementation Units\s*$/.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) {
    return null;
  }
  const end = lines.findIndex((line, i) => i >= start && /^##\s+/.test(line));
  return lines.slice(start, end < 0 ? lines.length : end);
}

/**
 * Parse a CE `ce-unified-plan/v1` document into its machine view. Throws
 * `PlanParseError` when the document has no `## Implementation Units` section
 * (nothing to supervise). Units are parsed from `### U<number>. <title>` H3
 * headings, keyed by U-ID, in document order.
 */
export function parsePlan(planText: string): ParsedPlan {
  const { frontmatterYaml, body } = splitFrontmatter(planText);

  let frontmatter: unknown = null;
  if (frontmatterYaml !== null) {
    try {
      frontmatter = parseYaml(frontmatterYaml);
    } catch (error) {
      throw new PlanParseError(
        `Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const sectionLines = extractImplementationUnitsSection(body);
  if (sectionLines === null) {
    throw new PlanParseError('No "## Implementation Units" section found');
  }

  const units: Record<UnitId, PlanUnit> = {};
  const unitIds: UnitId[] = [];
  const duplicateIds: UnitId[] = [];

  let current: { id: UnitId; number: number; title: string; start: number } | null = null;
  const flush = (end: number): void => {
    if (current === null) {
      return;
    }
    const section = sectionLines.slice(current.start, end);
    const unit = parseUnitSection(section, current.id, current.number, current.title);
    if (units[current.id] !== undefined) {
      duplicateIds.push(current.id);
    } else {
      units[current.id] = unit;
      unitIds.push(current.id);
    }
    current = null;
  };

  for (let i = 0; i < sectionLines.length; i++) {
    const match = sectionLines[i].match(UNIT_HEADING_PATTERN);
    if (!match) {
      continue;
    }
    flush(i);
    current = {
      id: `U${match[1]}`,
      number: Number(match[1]),
      title: match[2].trim(),
      start: i + 1,
    };
  }
  flush(sectionLines.length);

  return {
    title: yamlString(frontmatter, "title"),
    artifactContract: yamlString(frontmatter, "artifact_contract"),
    execution: yamlString(frontmatter, "execution"),
    units,
    unitIds,
    duplicateIds,
  };
}
