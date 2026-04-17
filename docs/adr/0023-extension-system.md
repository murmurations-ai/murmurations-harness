# ADR-0023 — Extension system compatible with OpenClaw plugins

- **Status:** Proposed
- **Date:** 2026-04-17
- **Decision-maker(s):** Source (design), Engineering Circle
- **Related:** ADR-0020 (Vercel AI SDK), ADR-0021 (CollaborationProvider), OpenClaw plugin SDK

## Context

The harness needs tools that agents can use during wakes: web search, web fetch, persistent memory, messaging channels. OpenClaw has 100+ extensions with a mature plugin SDK. Rather than reinventing, we should design our extension system to be compatible with OpenClaw plugins so they work as drop-in options.

OpenClaw's extension model:

- Each extension is a directory with `openclaw.plugin.json` (manifest) + `index.ts` (entry)
- Entry exports `definePluginEntry({ id, name, register(api) })`
- The `register` function calls `api.registerTool()`, `api.registerWebSearchProvider()`, etc.
- Tools are functions with a name, description, input schema, and `execute()` method
- Configuration via the manifest's `configSchema` + env vars listed in `providerAuthEnvVars`
- Skills via `SKILL.md` files in a `skills/` subdirectory

## Decision

### §1 — Extension directory structure (OpenClaw-compatible)

Extensions live in `extensions/` at the murmuration root (or in the harness repo for built-in ones):

```
extensions/
├── tavily/
│   ├── openclaw.plugin.json    # manifest (OpenClaw-compatible)
│   ├── index.ts                # entry point
│   ├── skills/                 # SKILL.md files (already supported via SkillScanner)
│   └── src/                    # implementation
├── brave/
├── memory/
└── slack/
```

### §2 — Extension manifest (`openclaw.plugin.json`)

We adopt OpenClaw's manifest format as-is:

```json
{
  "id": "tavily",
  "skills": ["./skills"],
  "providerAuthEnvVars": {
    "tavily": ["TAVILY_API_KEY"]
  },
  "contracts": {
    "tools": ["tavily_search", "tavily_extract"]
  },
  "configSchema": { ... }
}
```

The harness reads this to:

- Discover required env vars (and check they're set)
- Know which tools the extension provides
- Find skill directories for the SkillScanner

### §3 — Extension API (harness-native, OpenClaw-inspired)

The harness provides a `MurmurationPluginApi` that mirrors the subset of OpenClaw's `OpenClawPluginApi` that we need:

```typescript
interface MurmurationPluginApi {
  /** Register a tool that agents can use during wakes. */
  registerTool(tool: ToolDefinition): void;

  /** Register a web search provider. */
  registerWebSearchProvider(provider: WebSearchProvider): void;

  /** Access murmuration configuration. */
  getConfig(): HarnessConfig;

  /** Access secrets (env vars). */
  getSecret(key: string): string | undefined;
}

interface ExtensionEntry {
  id: string;
  name: string;
  description: string;
  register(api: MurmurationPluginApi): void;
}
```

### §4 — Extension loading at boot

At daemon startup:

1. Scan `extensions/` directory for subdirectories with `openclaw.plugin.json`
2. Check env vars from `providerAuthEnvVars` — skip extensions with missing required keys
3. Call `register(api)` on each extension's entry point
4. Registered tools are available to all agents (or scoped per agent via role.md)
5. Skills from extension `skills/` directories are merged into the SkillScanner

### §5 — OpenClaw compatibility layer

For extensions that import from `openclaw/plugin-sdk/*`, we provide a shim:

```typescript
// @murmurations-ai/openclaw-compat
// Shims for OpenClaw plugin SDK imports
export { definePluginEntry } from "./compat.js";
export type { OpenClawPluginApi, AnyAgentTool } from "./compat.js";
```

This allows OpenClaw extensions to work unmodified if they only use the tool registration API. Extensions using advanced OpenClaw features (channels, providers, transport) would need adaptation.

### §6 — Tool availability in role.md

Agents declare which extensions they use:

```yaml
# role.md
tools:
  extensions:
    - tavily # all tools from this extension
    - brave # alternative web search
  mcp:
    - name: github # MCP tools (existing)
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
```

If `tools.extensions` is omitted, all registered extensions are available. If specified, only listed extensions' tools are passed to `generateText()`.

### §7 — Built-in extensions ship with the harness

The harness ships these built-in extensions in `examples/extensions/` (or a `@murmurations-ai/extensions-*` package):

| Extension    | Tools                       | Key required     |
| ------------ | --------------------------- | ---------------- |
| `tavily`     | `web_search`, `web_extract` | `TAVILY_API_KEY` |
| `brave`      | `web_search`                | `BRAVE_API_KEY`  |
| `duckduckgo` | `web_search`                | None (keyless)   |
| `web-fetch`  | `fetch_url`                 | None             |

## Consequences

### Positive

- OpenClaw's 100+ extensions are potential drop-in tools
- Familiar pattern for OpenClaw users
- Skills and tools share the same discovery mechanism
- Extensions are self-contained (manifest + code + skills)
- Built-in extensions provide immediate value (web search, fetch)

### Negative

- OpenClaw compatibility shim may not cover all extension APIs
- Complex extensions (channels, voice, media) need adaptation
- Two tool systems (extensions + MCP) — but they serve different purposes

### Neutral

- MCP remains for external tool servers (stdio/HTTP)
- Extensions are for harness-native tools (bundled, no server to spawn)
- Both produce `ToolDefinition[]` for `generateText()`

## Implementation phases

| Phase | What                                                   | Effort |
| ----- | ------------------------------------------------------ | ------ |
| **1** | Extension loader + manifest parser + tool registration | Medium |
| **2** | Built-in web search extension (Tavily + DuckDuckGo)    | Small  |
| **3** | OpenClaw compatibility shim                            | Medium |
| **4** | Web fetch, memory, messaging extensions                | Large  |
