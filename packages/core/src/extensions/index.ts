/**
 * Extension system (ADR-0023) — OpenClaw-compatible plugin loading.
 */

export { loadExtensions } from "./loader.js";
export type {
  ExtensionEntry,
  ExtensionManifest,
  LoadedExtension,
  MurmurationPluginApi,
} from "./types.js";
