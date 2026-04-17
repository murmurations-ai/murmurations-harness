/**
 * Extension loader — scans extensions/ directory, reads manifests,
 * loads entry points, and registers tools (ADR-0023 §3-§4).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ToolDefinition,
  ExtensionEntry,
  ExtensionManifest,
  LoadedExtension,
  MurmurationPluginApi,
} from "./types.js";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Scan an extensions directory, load manifests, check env vars,
 * register tools, and return loaded extensions.
 *
 * Extensions with missing required env vars are skipped (not errors).
 */
export async function loadExtensions(
  extensionsDir: string,
  rootDir: string,
): Promise<readonly LoadedExtension[]> {
  const loaded: LoadedExtension[] = [];

  let entries: string[];
  try {
    entries = await readdir(extensionsDir);
  } catch {
    return loaded; // no extensions/ directory — that's fine
  }

  for (const entry of entries) {
    const extDir = join(extensionsDir, entry);
    try {
      const s = await stat(extDir);
      if (!s.isDirectory()) continue;

      const manifestPath = join(extDir, "openclaw.plugin.json");
      let manifestRaw: string;
      try {
        manifestRaw = await readFile(manifestPath, "utf8");
      } catch {
        continue; // no manifest — skip
      }

      const manifest = JSON.parse(manifestRaw) as ExtensionManifest;
      if (!manifest.id) continue;

      // Check required env vars
      if (manifest.providerAuthEnvVars) {
        let missingKey = false;
        for (const keys of Object.values(manifest.providerAuthEnvVars)) {
          const hasAny = keys.some((k) => process.env[k]);
          if (!hasAny) {
            missingKey = true;
            break;
          }
        }
        if (missingKey) continue; // skip — required credentials not available
      }

      // Load entry point
      const indexPath = join(extDir, "index.ts");
      const indexJsPath = join(extDir, "index.js");
      const indexMjsPath = join(extDir, "index.mjs");
      let entryPath: string | null = null;
      for (const candidate of [indexMjsPath, indexJsPath, indexPath]) {
        try {
          await stat(candidate);
          entryPath = candidate;
          break;
        } catch {
          continue;
        }
      }

      if (!entryPath) continue; // no entry point — skip

      const mod = (await import(pathToFileURL(entryPath).href)) as {
        default?: ExtensionEntry;
      };
      const extensionEntry = mod.default;
      if (!extensionEntry?.register) continue;

      // Register tools via the plugin API
      const tools: ToolDefinition[] = [];
      const api: MurmurationPluginApi = {
        registerTool: (tool) => tools.push(tool),
        getSecret: (key) => process.env[key],
        rootDir,
      };

      extensionEntry.register(api);

      // Collect skill directories
      const skillDirs: string[] = [];
      if (manifest.skills) {
        for (const skillRef of manifest.skills) {
          const skillDir = resolve(extDir, skillRef);
          try {
            const sd = await stat(skillDir);
            if (sd.isDirectory()) skillDirs.push(skillDir);
          } catch {
            // skill dir doesn't exist — skip
          }
        }
      }

      loaded.push({
        id: manifest.id,
        name: extensionEntry.name,
        manifest,
        tools,
        skillDirs,
      });
    } catch {
      // Skip extensions that fail to load — don't crash the daemon
    }
  }

  return loaded;
}
