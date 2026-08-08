/**
 * Hash-chained custody (R85, R45, KTD3, D8-g).
 *
 * Every harvested artifact carries a custody header `(role, agent_id, attempt,
 * take, harvest_ts, content_hash, prev_hash)`. Headers are appended into a
 * single per-run chain ordered by harvest time: each header's `prev_hash` is
 * the `content_hash` of the previous header in the chain (the first header's
 * `prev_hash` is null). A broken or missing link is an evidence gap (R45) —
 * never silent corruption — and cannot support acceptance (R51).
 *
 * The chain is persisted as `evidence/custody-chain.json` in the run store;
 * every harvest appends its artifacts to it. This module owns the chain data
 * structure, the SHA-256 content hashing, chain verification, and chain file
 * persistence (temp-write-then-rename, the repo's atomic-write primitive).
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * One custody header (R85, KTD3). Carries exactly the mandated fields plus
 * `artifact` — the evidence-path relative to the run's evidence root
 * (e.g. `U1/t1/builder/diff.patch`) — which ties the header to the file it
 * seals. `prev_hash` is `null` for the first header in the chain.
 */
export interface CustodyHeader {
  role: string;
  agent_id: string;
  attempt: string;
  take: number;
  harvest_ts: number;
  content_hash: string;
  prev_hash: string | null;
  artifact: string;
}

/** The persisted chain file shape. */
export interface CustodyChainFile {
  version: 1;
  headers: CustodyHeader[];
}

/** Filename of the per-run custody chain under the evidence dir. */
export const CUSTODY_CHAIN_FILENAME = "custody-chain.json";

/** Absolute path of the custody chain file for a run's evidence dir. */
export function custodyChainPath(evidenceDir: string): string {
  return path.join(evidenceDir, CUSTODY_CHAIN_FILENAME);
}

/** SHA-256 content hash (hex) of a string or buffer (R85). */
export function computeArtifactHash(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Unit id referenced by a custody `artifact` path (`<unit>/<take>/<role>/...`). */
export function unitFromArtifact(artifact: string): string {
  const first = artifact.split("/")[0];
  return first.length > 0 ? first : "unknown";
}

/**
 * Pure append: chain `header` onto `chain`, stamping `prev_hash` from the
 * prior header's `content_hash` (null for the first header). Returns a new
 * array; the chain stays ordered by harvest time (R85).
 */
export function appendToChain(
  chain: CustodyHeader[],
  header: Omit<CustodyHeader, "prev_hash">,
): CustodyHeader[] {
  const prevHash = chain.length === 0 ? null : chain[chain.length - 1].content_hash;
  return [...chain, { ...header, prev_hash: prevHash }];
}

/** A chain link whose `prev_hash` does not chain to the preceding header. */
export interface BrokenLink {
  /** Header index in the chain array. */
  index: number;
  artifact: string;
  expectedPrevHash: string | null;
  actualPrevHash: string | null;
}

/** Structural verdict over a custody chain (R45). */
export interface ChainVerification {
  ok: boolean;
  brokenLinks: BrokenLink[];
}

/**
 * Verify the hash-chain invariant: the first header's `prev_hash` is null and
 * every later header's `prev_hash` equals the preceding header's `content_hash`
 * (R85). A deleted or reordered header breaks the link and is reported.
 */
export function verifyChain(chain: CustodyHeader[]): ChainVerification {
  const brokenLinks: BrokenLink[] = [];
  for (let i = 0; i < chain.length; i++) {
    const header = chain[i];
    const expected = i === 0 ? null : chain[i - 1].content_hash;
    if (header.prev_hash !== expected) {
      brokenLinks.push({
        index: i,
        artifact: header.artifact,
        expectedPrevHash: expected,
        actualPrevHash: header.prev_hash,
      });
    }
  }
  return { ok: brokenLinks.length === 0, brokenLinks };
}

/** Read the persisted chain; an absent or unreadable file yields an empty chain. */
export function readChainFile(chainPath: string): CustodyHeader[] {
  let raw: string;
  try {
    raw = fs.readFileSync(chainPath, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return [];
    }
    const file = parsed as Record<string, unknown>;
    if (file.version !== 1 || !Array.isArray(file.headers)) {
      return [];
    }
    return file.headers as CustodyHeader[];
  } catch {
    return [];
  }
}

/**
 * Persist the chain atomically (temp-write-then-rename, KTD2). A torn write
 * can never destroy the prior chain: the rename either lands the new file or
 * leaves the old one intact.
 */
export function writeChainFile(chainPath: string, headers: CustodyHeader[]): void {
  fs.mkdirSync(path.dirname(chainPath), { recursive: true });
  const file: CustodyChainFile = { version: 1, headers };
  const tmp = `${chainPath}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tmp, chainPath);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    throw error;
  }
}
