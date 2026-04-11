/**
 * `murmuration directive` — Source → murmuration communication.
 *
 * Usage:
 *   murmuration directive --agent 01-research "Validate this topic"
 *   murmuration directive --circle content "Should this circle hold meetings?"
 *   murmuration directive --all "Propose your ideal wake cadence"
 *   murmuration directive --list                    # show all directives
 *   murmuration directive --list --status pending   # show pending only
 */

import { resolve } from "node:path";

import { DirectiveStore, type DirectiveScope } from "@murmuration/core";

export const runDirective = async (
  args: readonly string[],
  rootDir: string,
): Promise<void> => {
  const store = new DirectiveStore(resolve(rootDir));

  // Parse args
  if (args.includes("--list")) {
    const statusIdx = args.indexOf("--status");
    const statusFilter = statusIdx >= 0 ? args[statusIdx + 1] : undefined;
    const all = await store.list();
    const filtered = statusFilter ? all.filter((d) => d.status === statusFilter) : all;
    if (filtered.length === 0) {
      console.log("No directives found.");
      return;
    }
    for (const d of filtered) {
      const scopeStr =
        d.scope.kind === "all"
          ? "all"
          : d.scope.kind === "agent"
            ? `agent:${d.scope.agentId}`
            : `circle:${d.scope.circleId}`;
      const responses = d.responses?.length ?? 0;
      console.log(
        `  ${d.id}  ${d.status.padEnd(10)} ${scopeStr.padEnd(20)} ${d.kind.padEnd(12)} ${String(responses)} responses`,
      );
      console.log(`    "${d.body.slice(0, 80)}${d.body.length > 80 ? "..." : ""}"`);
      if (d.responses && d.responses.length > 0) {
        for (const r of d.responses) {
          console.log(`    └─ ${r.agentId}: ${r.excerpt.slice(0, 60)}...`);
        }
      }
    }
    return;
  }

  // Determine scope
  let scope: DirectiveScope;
  const agentIdx = args.indexOf("--agent");
  const circleIdx = args.indexOf("--circle");
  const allFlag = args.includes("--all");

  if (agentIdx >= 0 && args[agentIdx + 1]) {
    scope = { kind: "agent", agentId: args[agentIdx + 1]! };
  } else if (circleIdx >= 0 && args[circleIdx + 1]) {
    scope = { kind: "circle", circleId: args[circleIdx + 1]! };
  } else if (allFlag) {
    scope = { kind: "all" };
  } else {
    console.error(
      "murmuration directive: specify --agent <id>, --circle <id>, or --all",
    );
    process.exit(2);
    return;
  }

  // The body is the last positional argument (not a flag value)
  const body = args.filter((a) => !a.startsWith("--")).pop()
    ?? args[args.length - 1];

  if (!body || body.startsWith("--")) {
    console.error('murmuration directive: provide a message body as the last argument');
    process.exit(2);
    return;
  }

  const directive = await store.create(scope, "question", body);
  const scopeStr =
    scope.kind === "all"
      ? "all agents"
      : scope.kind === "agent"
        ? `agent ${scope.agentId}`
        : `circle ${scope.circleId}`;

  console.log(`Directive created: ${directive.id}`);
  console.log(`  Scope: ${scopeStr}`);
  console.log(`  Body: "${body}"`);
  console.log(`  Status: pending`);
  console.log(`\nAgents will receive this directive on their next wake.`);
};
