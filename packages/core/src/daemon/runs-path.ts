/**
 * Runs directory path resolution.
 *
 * Canonical location: `<rootDir>/runs/<agent>/<YYYY-MM-DD>/digest-*.md`
 *
 * Legacy location: `<rootDir>/.murmuration/runs/<agent>/<YYYY-MM-DD>/digest-*.md`
 *
 * The legacy location hid real content (agent-authored digests) inside
 * a dot-dir intended for daemon-managed runtime state. v0.5.x moves
 * runs/ out to the root so operators can see and browse their agents'
 * work like any other content directory. Readers check both paths
 * during the transition so existing murmurations keep working without
 * a manual migration step.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export const RUNS_DIR_NAME = "runs";

/** Canonical runs dir — what new writes use. */
export const runsDir = (rootDir: string): string => join(rootDir, RUNS_DIR_NAME);

/** Legacy runs dir — writes from pre-v0.5.x went here. */
export const legacyRunsDir = (rootDir: string): string =>
  join(rootDir, ".murmuration", RUNS_DIR_NAME);

/**
 * Return the runs dir that exists for this agent, preferring the
 * canonical location. Falls back to the legacy path only when the
 * canonical one hasn't been created yet AND legacy exists. Always
 * returns the canonical path when neither exists (so writers default
 * to the new layout).
 */
export const runsDirForAgent = (rootDir: string, agentId: string): string => {
  const canonical = join(runsDir(rootDir), agentId);
  if (existsSync(canonical)) return canonical;
  const legacy = join(legacyRunsDir(rootDir), agentId);
  if (existsSync(legacy)) return legacy;
  return canonical;
};

/**
 * One-time auto-migration: if legacy `<root>/.murmuration/runs/`
 * exists and canonical `<root>/runs/` doesn't, rename legacy → new.
 * Called at daemon boot so operators don't have to think about the
 * migration. Safe to call repeatedly — no-op when already migrated.
 */
export const migrateLegacyRunsDir = async (rootDir: string): Promise<boolean> => {
  const legacy = legacyRunsDir(rootDir);
  const canonical = runsDir(rootDir);
  if (!existsSync(legacy) || existsSync(canonical)) return false;
  const { rename } = await import("node:fs/promises");
  try {
    await rename(legacy, canonical);
    return true;
  } catch {
    return false;
  }
};
