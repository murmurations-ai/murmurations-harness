/**
 * `murmuration providers list` — show the LLM providers registered on
 * the default registry (built-in providers only). Extension-registered
 * providers only appear at daemon boot time; to see those, check the
 * daemon log for the `daemon.providers.roster` event, or run against
 * a live daemon (Phase 3 adds a `providers.list` socket RPC).
 */

import { buildBuiltinProviderRegistry } from "./builtin-providers/index.js";

export const runProviders = async (args: readonly string[]): Promise<void> => {
  const verb = args[0] ?? "list";

  if (verb !== "list") {
    console.error(`murmuration providers: unknown subcommand "${verb}" (expected: list)`);
    process.exit(2);
  }

  const registry = buildBuiltinProviderRegistry();
  const providers = registry.list();
  const jsonFlag = args.includes("--json");

  if (jsonFlag) {
    process.stdout.write(
      JSON.stringify(
        providers.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          envKeyName: p.envKeyName,
          tiers: p.tiers ?? null,
        })),
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const header = `${"ID".padEnd(12)} ${"NAME".padEnd(20)} ${"ENV KEY".padEnd(20)} TIERS`;
  console.log(header);
  console.log("─".repeat(header.length + 20));
  for (const p of providers) {
    const env = p.envKeyName ?? "(keyless)";
    const tiers = p.tiers
      ? `fast=${p.tiers.fast} · balanced=${p.tiers.balanced} · deep=${p.tiers.deep}`
      : "(none)";
    console.log(`${p.id.padEnd(12)} ${p.displayName.padEnd(20)} ${env.padEnd(20)} ${tiers}`);
  }
  console.log(
    "\n(Built-in providers only. Extension-registered providers load at daemon boot;\n see the `daemon.providers.roster` event in the daemon log.)",
  );

  return Promise.resolve();
};
