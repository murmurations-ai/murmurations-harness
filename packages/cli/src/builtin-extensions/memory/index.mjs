/**
 * Built-in memory extension — ADR-0029.
 *
 * This is a MARKER entry: it registers the extension id `memory` so
 * the extension loader discovers it, but it contributes no shared
 * tools. Memory is agent-scoped, so the tools are constructed
 * per-agent at wake time by `buildMemoryToolsForAgent()` in
 * `packages/cli/src/memory/index.ts`, then merged into the agent's
 * tool list by `selectExtensionToolsFor()` in boot.
 *
 * Declare in `role.md`:
 *   plugins:
 *     - provider: "@murmurations-ai/memory"
 *
 * When the murmuration uses the local CollaborationProvider, memory
 * is auto-included alongside files (same pattern as v0.4.3), because
 * durable learnings are a basic governance hygiene need.
 */

/** @type {import("@murmurations-ai/core").ExtensionEntry} */
export default {
  id: "memory",
  name: "Agent Memory",
  description:
    "Persistent remember / recall / forget across wakes, agent-scoped (ADR-0029). Tools are built per-agent in boot, not registered here.",
  register(_api) {
    // Intentional no-op: tools are agent-bound and injected
    // per-agent in selectExtensionToolsFor, not at load time.
  },
};
