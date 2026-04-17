/**
 * Extension system types — OpenClaw-compatible plugin interface (ADR-0023).
 *
 * Extensions register tools that agents can use during wakes.
 * The manifest format matches OpenClaw's openclaw.plugin.json.
 */

/** Tool definition — matches @murmurations-ai/llm's ToolDefinition structurally. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly execute: (input: Record<string, unknown>) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Plugin manifest (openclaw.plugin.json)
// ---------------------------------------------------------------------------

/** OpenClaw-compatible plugin manifest. */
export interface ExtensionManifest {
  readonly id: string;
  readonly skills?: readonly string[];
  readonly providerAuthEnvVars?: Readonly<Record<string, readonly string[]>>;
  readonly contracts?: {
    readonly tools?: readonly string[];
    readonly webSearchProviders?: readonly string[];
  };
  readonly configSchema?: unknown;
}

// ---------------------------------------------------------------------------
// Plugin API (subset of OpenClaw's OpenClawPluginApi)
// ---------------------------------------------------------------------------

/** API provided to extensions during registration. */
export interface MurmurationPluginApi {
  /** Register a tool that agents can use during wakes. */
  registerTool(tool: ToolDefinition): void;

  /** Access a secret (env var) by name. */
  getSecret(key: string): string | undefined;

  /** The murmuration root directory. */
  readonly rootDir: string;
}

/** Entry point that each extension exports. */
export interface ExtensionEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  register(api: MurmurationPluginApi): void;
}

// ---------------------------------------------------------------------------
// Loaded extension (runtime state)
// ---------------------------------------------------------------------------

/** An extension that has been loaded and registered. */
export interface LoadedExtension {
  readonly id: string;
  readonly name: string;
  readonly manifest: ExtensionManifest;
  readonly tools: readonly ToolDefinition[];
  readonly skillDirs: readonly string[];
}
