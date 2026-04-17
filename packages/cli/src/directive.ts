/**
 * `murmuration directive` — Source → murmuration communication via
 * the configured {@link CollaborationProvider} (GitHub issues or local
 * YAML items).
 *
 * Directives are items with the `source-directive` label + scope labels.
 * Agents see them through the existing signal aggregator. Responses are
 * item comments.
 *
 * Usage:
 *   murmuration directive --root ../my-murmuration --agent 01-research "Validate this topic"
 *   murmuration directive --root ../my-murmuration --group content "Should this group hold meetings?"
 *   murmuration directive --root ../my-murmuration --all "Propose your ideal wake cadence"
 *   murmuration directive --root ../my-murmuration --list
 */

import { resolve } from "node:path";

import { buildCollaborationProvider, CollaborationBuildError } from "./collaboration-factory.js";

export const runDirective = async (args: readonly string[], rootDir: string): Promise<void> => {
  const root = resolve(rootDir);

  // Determine scope
  const agentIdx = args.indexOf("--agent");
  const groupIdx = args.indexOf("--group");
  const allFlag = args.includes("--all");

  let scopeLabel: string;
  let scopeDesc: string;
  const agentArg = args[agentIdx + 1];
  const groupArg = args[groupIdx + 1];
  if (agentIdx >= 0 && agentArg) {
    scopeLabel = `scope:agent:${agentArg}`;
    scopeDesc = `agent ${agentArg}`;
  } else if (groupIdx >= 0 && groupArg) {
    scopeLabel = `scope:group:${groupArg}`;
    scopeDesc = `group ${groupArg}`;
  } else if (allFlag) {
    scopeLabel = "scope:all";
    scopeDesc = "all agents";
  } else if (!args.includes("--list")) {
    throw new Error("murmuration directive: specify --agent <id>, --group <id>, --all, or --list");
  } else {
    scopeLabel = "";
    scopeDesc = "";
  }

  let provider;
  try {
    ({ provider } = await buildCollaborationProvider(root));
  } catch (err) {
    if (err instanceof CollaborationBuildError) {
      throw new Error(`murmuration directive: ${err.message}`, { cause: err });
    }
    throw err;
  }

  // --list mode
  if (args.includes("--list")) {
    const result = await provider.listItems({
      state: "all",
      labels: ["source-directive"],
      limit: 20,
    });
    if (!result.ok) {
      throw new Error(`${provider.displayName} error: ${result.error.code}`);
    }
    if (result.value.length === 0) {
      console.log("No directives found.");
      return;
    }
    for (const item of result.value) {
      const state = item.state === "open" ? "pending" : "responded";
      const scope = item.labels.find((l) => l.startsWith("scope:")) ?? "scope:?";
      console.log(
        `  ${item.ref.id.padEnd(6)} ${state.padEnd(10)} ${scope.padEnd(20)} ${item.title.slice(0, 60)}`,
      );
    }
    return;
  }

  // Body is the last positional argument
  const body = args.filter((a) => !a.startsWith("--")).pop();
  if (!body || body.startsWith("--")) {
    throw new Error("murmuration directive: provide a message body as the last argument");
  }

  const directiveBody = [
    `**From:** Source`,
    `**Scope:** ${scopeDesc}`,
    `**Kind:** question`,
    ``,
    body,
    ``,
    `---`,
    `_Created by \`murmuration directive\`. Agents will respond on their next wake._`,
  ].join("\n");

  const createResult = await provider.createItem({
    title: `[DIRECTIVE] ${body.slice(0, 80)}`,
    body: directiveBody,
    labels: ["source-directive", scopeLabel],
  });

  if (!createResult.ok) {
    throw new Error(
      `${provider.displayName} error: ${createResult.error.code} — ${createResult.error.message}`,
    );
  }

  console.log(`Directive created: ${createResult.value.id}`);
  if (createResult.value.url) console.log(`  URL: ${createResult.value.url}`);
  console.log(`  Scope: ${scopeDesc}`);
  console.log(`  Labels: source-directive, ${scopeLabel}`);
  console.log(`\nAgents will see this item as a signal on their next wake.`);
};
