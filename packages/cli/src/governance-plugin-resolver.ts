/**
 * Shared governance-plugin resolution logic — used by both `boot.ts`
 * (at runtime) and `doctor.ts` (at preflight) so they agree on what
 * is and isn't a loadable plugin spec.
 *
 * v0.5.0 Milestone 4.7. The bug this fixes: `harness.yaml` with
 * `plugin: s3` (a well-known short name) used to crash boot because
 * the resolver only tried (1) npm require, (2) relative path. It
 * never recognized that `s3` is the bundled Sociocracy 3.0 plugin
 * shipped with the CLI. Now it does.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Short-name → bundled plugin entry-point map. When `harness.yaml`
 * sets one of these names, the harness loads the plugin shipped
 * inside the CLI package (no npm install, no local copy required).
 * Safe to extend as the harness authors more built-in plugins.
 */
const BUNDLED_PLUGIN_ALIASES: Readonly<Record<string, string>> = {
  s3: "governance-plugins/s3/index.mjs",
  "self-organizing": "governance-plugins/s3/index.mjs",
};

/**
 * Resolve a bundled plugin alias (e.g. `"s3"`) to an absolute file
 * path to the plugin entry-point inside the CLI package. Returns null
 * when the name isn't a known alias or the file doesn't exist.
 *
 * Works from both the compiled `dist/` and the `src/` tree (for
 * tests and pnpm dev), same dual-path technique as default-agent
 * templates.
 */
export const resolveBundledGovernancePlugin = (name: string): string | null => {
  const rel = BUNDLED_PLUGIN_ALIASES[name];
  if (!rel) return null;

  // Use this file's own URL to locate siblings rather than trusting
  // import.meta of the caller, so both boot.ts (dist) and doctor.ts
  // (dist) find the bundled plugin in their own dist tree.
  const here = dirname(fileURLToPath(import.meta.url));
  const shipped = join(here, rel);
  if (existsSync(shipped)) return shipped;
  const fromSrc = join(here, "..", "src", rel);
  if (existsSync(fromSrc)) return fromSrc;
  return null;
};

/**
 * Probe whether a governance plugin spec is loadable without actually
 * importing it. Used by `doctor` to report specific failure modes
 * (bundled alias vs local path vs npm package) with accurate
 * remediation before the operator runs `start` and hits a crash.
 */
export type GovernancePluginProbe =
  | { readonly kind: "bundled-alias"; readonly path: string }
  | { readonly kind: "local-path"; readonly path: string }
  | { readonly kind: "npm-package"; readonly package: string }
  | {
      readonly kind: "unresolvable";
      readonly attempted: readonly string[];
    };

/** Try the same resolution order boot.ts uses; return which (if any) wins. */
export const probeGovernancePlugin = (rootDir: string, spec: string): GovernancePluginProbe => {
  const attempted: string[] = [];

  // 1. Bundled alias
  const bundled = resolveBundledGovernancePlugin(spec);
  if (bundled) return { kind: "bundled-alias", path: bundled };
  attempted.push(`bundled alias "${spec}"`);

  // 2. Relative file path (./foo or ../foo) — check against rootDir
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const resolved = resolve(rootDir, spec.replace(/^\.\//, ""));
    if (existsSync(resolved)) return { kind: "local-path", path: resolved };
    attempted.push(`relative path ${resolved}`);
    return { kind: "unresolvable", attempted };
  }

  // 3. Absolute path
  if (spec.startsWith("/")) {
    if (existsSync(spec)) return { kind: "local-path", path: spec };
    attempted.push(`absolute path ${spec}`);
    return { kind: "unresolvable", attempted };
  }

  // 4. npm package — probe via require.resolve from rootDir
  try {
    const localRequire = createRequire(join(rootDir, "package.json"));
    const resolved = localRequire.resolve(spec);
    return { kind: "npm-package", package: resolved };
  } catch {
    attempted.push(`npm package "${spec}" (not resolvable from ${rootDir})`);
  }

  return { kind: "unresolvable", attempted };
};

/** All known bundled plugin short names. */
export const listBundledPluginAliases = (): readonly string[] => {
  return Object.keys(BUNDLED_PLUGIN_ALIASES).sort();
};
