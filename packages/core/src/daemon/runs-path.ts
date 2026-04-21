/**
 * Runs directory path resolution.
 *
 * Canonical location: `<rootDir>/runs/<agent>/<YYYY-MM-DD>/digest-*.md`
 *
 * Pre-v0.5 used `<rootDir>/.murmuration/runs/`; operators who still
 * have data there can run `mv .murmuration/runs runs` once. The
 * harness no longer reads the legacy location.
 */

import { join } from "node:path";

export const RUNS_DIR_NAME = "runs";

/** `<rootDir>/runs` — base runs directory. */
export const runsDir = (rootDir: string): string => join(rootDir, RUNS_DIR_NAME);

/** `<rootDir>/runs/<agentId>` — per-agent runs directory. */
export const runsDirForAgent = (rootDir: string, agentId: string): string =>
  join(runsDir(rootDir), agentId);
