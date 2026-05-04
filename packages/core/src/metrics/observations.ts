/**
 * AccountabilityObservationStore — durable JSONL log of done_when
 * validator outcomes per wake.
 *
 * Wake-end flow (Workstream H):
 *
 *   1. Wake completes; the daemon has the agent's role.md
 *      `accountabilities` block from the frontmatter.
 *   2. For each accountability, run `validateAccountability` against
 *      current state via the configured StateProbe.
 *   3. Append one {@link AccountabilityObservation} per accountability
 *      to this store.
 *   4. The metrics module's `computeAccountabilityMetRates` reads the
 *      observations to compute per-id met-rate over a window.
 *
 * Storage: one JSONL file per murmuration at
 * `<rootDir>/.murmuration/accountability-observations.jsonl` —
 * append-only, single writer (the daemon), bounded by daily/wake
 * cadence so growth is linear in agent-count × wake-count.
 *
 * @see docs/specs/0001-agent-effectiveness.md §6 Workstream H
 * @see ADR-0042 Part 1 (done_when schema)
 */

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AccountabilityObservation } from "./effectiveness.js";

export interface ObservationStoreConfig {
  /** Absolute path to the JSONL store. */
  readonly path: string;
}

/**
 * Append-only JSONL store. Reads load the entire file (bounded by
 * the daemon's retention policy — see {@link prune}).
 */
export class AccountabilityObservationStore {
  readonly #path: string;

  public constructor(config: ObservationStoreConfig) {
    this.#path = config.path;
  }

  /**
   * Append one observation. Creates the directory + file if needed.
   * Single-writer assumption — concurrent writers may interleave
   * lines but each line is atomic (one fs.appendFile call).
   */
  public async append(observation: AccountabilityObservation): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const line = JSON.stringify(serializeObservation(observation)) + "\n";
    await appendFile(this.#path, line, "utf8");
  }

  /**
   * Append a batch in one fs call. Useful at wake-end when the
   * daemon emits one observation per declared accountability —
   * often 3–5 in a single write.
   */
  public async appendAll(observations: readonly AccountabilityObservation[]): Promise<void> {
    if (observations.length === 0) return;
    await mkdir(dirname(this.#path), { recursive: true });
    const lines =
      observations.map((o) => JSON.stringify(serializeObservation(o))).join("\n") + "\n";
    await appendFile(this.#path, lines, "utf8");
  }

  /**
   * Read every observation. Tolerates malformed lines (skips them
   * with no error). Returns empty array when the file does not
   * exist — first-wake / fresh murmurations are not an error case.
   */
  public async readAll(): Promise<readonly AccountabilityObservation[]> {
    let content: string;
    try {
      content = await readFile(this.#path, "utf8");
    } catch {
      return [];
    }
    const out: AccountabilityObservation[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const raw: unknown = JSON.parse(trimmed);
        const parsed = parseObservation(raw);
        if (parsed) out.push(parsed);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  }

  /**
   * Read observations within a time window. Convenience over
   * `readAll` + filter; the loader still scans the entire file
   * because JSONL has no native indexing.
   */
  public async readWindow(input: {
    readonly since: Date;
    readonly until: Date;
  }): Promise<readonly AccountabilityObservation[]> {
    const all = await this.readAll();
    return all.filter((o) => o.observedAt >= input.since && o.observedAt <= input.until);
  }

  /**
   * Drop observations older than `cutoff`. Rewrites the file with
   * the kept entries. The metrics module's met-rate is windowed,
   * so observations outside the largest reasonable window
   * (typically 90 days) carry no decision-relevant signal.
   *
   * No-op when the file does not exist or has no entries to drop.
   */
  public async prune(cutoff: Date): Promise<{ readonly droppedCount: number }> {
    const all = await this.readAll();
    const kept = all.filter((o) => o.observedAt >= cutoff);
    const dropped = all.length - kept.length;
    if (dropped === 0) return { droppedCount: 0 };
    const lines = kept.map((o) => JSON.stringify(serializeObservation(o))).join("\n");
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, lines + (lines.length > 0 ? "\n" : ""), "utf8");
    return { droppedCount: dropped };
  }
}

// ---------------------------------------------------------------------------
// JSON shape (Date ↔ string round-trip)
// ---------------------------------------------------------------------------

interface SerializedObservation {
  readonly accountabilityId: string;
  readonly agentId: string;
  readonly observedAt: string;
  readonly met: boolean;
}

const serializeObservation = (o: AccountabilityObservation): SerializedObservation => ({
  accountabilityId: o.accountabilityId,
  agentId: o.agentId,
  observedAt: o.observedAt.toISOString(),
  met: o.met,
});

const parseObservation = (raw: unknown): AccountabilityObservation | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<SerializedObservation>;
  if (
    typeof r.accountabilityId !== "string" ||
    typeof r.agentId !== "string" ||
    typeof r.observedAt !== "string" ||
    typeof r.met !== "boolean"
  ) {
    return null;
  }
  const observedAt = new Date(r.observedAt);
  if (Number.isNaN(observedAt.getTime())) return null;
  return {
    accountabilityId: r.accountabilityId,
    agentId: r.agentId,
    observedAt,
    met: r.met,
  };
};
