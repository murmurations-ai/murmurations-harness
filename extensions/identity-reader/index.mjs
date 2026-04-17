/**
 * Identity reader extension — agents can read their own and peer
 * identity docs (soul.md, role.md) during wakes and meetings.
 *
 * Tools:
 * - read_identity: Read an agent's soul.md and role.md
 * - list_agents: List all agents in the murmuration with names and groups
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** @type {import("@murmurations-ai/core").ExtensionEntry} */
export default {
  id: "identity-reader",
  name: "Identity Reader",
  description:
    "Read agent identity documents (soul.md, role.md) for self-reflection, peer review, and governance rounds",

  register(api) {
    const rootDir = api.rootDir;

    // --- read_identity tool ---
    api.registerTool({
      name: "read_identity",
      description:
        "Read an agent's identity documents (soul.md and role.md). Use this when you need to review your own or a peer's role definition, accountabilities, mental models, or voice. Returns the full content of both files.",
      parameters: z.object({
        agentId: z
          .string()
          .describe(
            "The agent ID to read (e.g. '22-engineering-lead', '23-architecture'). Use list_agents to find valid IDs.",
          ),
      }),
      execute: async (input) => {
        const agentId = input.agentId;
        const agentDir = join(rootDir, "agents", agentId);

        let soul = "";
        let role = "";
        let roleFrontmatter = "";

        try {
          soul = await readFile(join(agentDir, "soul.md"), "utf8");
        } catch {
          soul = "(soul.md not found)";
        }

        try {
          const roleContent = await readFile(join(agentDir, "role.md"), "utf8");
          // Split frontmatter from body
          const fmMatch = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(roleContent);
          if (fmMatch) {
            roleFrontmatter = fmMatch[1] || "";
            role = fmMatch[2] || "";
          } else {
            role = roleContent;
          }
        } catch {
          role = "(role.md not found)";
        }

        // Extract key metadata from frontmatter
        const nameMatch = /name:\s*"?([^"\n]+)"?/i.exec(roleFrontmatter);
        const groupMatch = /group_memberships:\s*\n([\s\S]*?)(?=\n\w|\n$)/i.exec(roleFrontmatter);
        const tierMatch = /model_tier:\s*"?([^"\n]+)"?/i.exec(roleFrontmatter);
        const agentName = nameMatch?.[1]?.trim() ?? agentId;
        const groups =
          groupMatch?.[1]
            ?.split("\n")
            .map((l) => l.replace(/^\s*-\s*"?/, "").replace(/"?\s*$/, ""))
            .filter((l) => l.length > 0) ?? [];
        const tier = tierMatch?.[1]?.trim() ?? "unknown";

        return [
          `# Identity: ${agentId} (${agentName})`,
          "",
          `**Groups:** ${groups.length > 0 ? groups.join(", ") : "(none)"}`,
          `**Model tier:** ${tier}`,
          "",
          "## Configuration (role.md frontmatter)",
          "```yaml",
          roleFrontmatter,
          "```",
          "",
          "## Soul",
          soul,
          "",
          "## Role",
          role,
        ].join("\n");
      },
    });

    // --- list_agents tool ---
    api.registerTool({
      name: "list_agents",
      description:
        "List all agents in the murmuration with their names and group memberships. Use this to discover valid agent IDs before calling read_identity.",
      parameters: z.object({}),
      execute: async () => {
        const agentsDir = join(rootDir, "agents");
        let dirs;
        try {
          dirs = await readdir(agentsDir);
        } catch {
          return "No agents directory found.";
        }

        const agents = [];
        for (const dir of dirs.sort()) {
          try {
            const roleContent = await readFile(join(agentsDir, dir, "role.md"), "utf8");
            const nameMatch = /name:\s*"?([^"\n]+)"?/i.exec(roleContent);
            const groupMatch = /group_memberships:\s*\n([\s\S]*?)(?=\n\w|\n---|\n$)/i.exec(
              roleContent,
            );
            const name = nameMatch?.[1]?.trim() ?? dir;
            const groups =
              groupMatch?.[1]
                ?.split("\n")
                .map((l) => l.replace(/^\s*-\s*"?/, "").replace(/"?\s*$/, ""))
                .filter((l) => l.length > 0) ?? [];

            agents.push(
              `- **${dir}** — ${name}${groups.length > 0 ? ` [${groups.join(", ")}]` : ""}`,
            );
          } catch {
            agents.push(`- **${dir}** — (could not read role.md)`);
          }
        }

        return agents.length > 0
          ? `## Agents in this murmuration\n\n${agents.join("\n")}`
          : "No agents found.";
      },
    });
  },
};
