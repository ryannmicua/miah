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
import { AcceptanceCriterion, ParsedPlan, PlanUnit, UnitId } from "./types";

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
      default:
        break;
    }
  }

  return { id, number, title, goal, requirements, creates, inputs, dependsOn, acceptance };
}

/**
 * Tier marker trailing an acceptance criterion, e.g. `— \`tier: deterministic\``.
 * Anchored at the end so mid-text "tier" mentions (in prose or paths) are not
 * treated as declarations.
 */
const TIER_PATTERN = /(?:[–—-]\s*)?`?tier\s*[:=]\s*`?([A-Za-z][A-Za-z-]*)`?$/i;

/** Parse a tier: marker off an acceptance criterion's text (R28, R47). */
export function parseCriterion(text: string): AcceptanceCriterion {
  const tierMatch = text.match(TIER_PATTERN);
  if (!tierMatch) {
    return { text, tier: null };
  }
  const tier = tierMatch[1].toLowerCase();
  const withoutTier = text.replace(tierMatch[0], "").trim();
  return { text: withoutTier || text, tier };
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
