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
 *   murmuration directive --root ../my-murmuration --group content --body-file ./directive.md
 *   murmuration directive --root ../my-murmuration --list
 *   murmuration directive --root ../my-murmuration close <id>
 *   murmuration directive --root ../my-murmuration delete <id>   # local provider only
 *   murmuration directive --root ../my-murmuration edit <id>     # local provider only
 */

import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { buildCollaborationProvider, CollaborationBuildError } from "./collaboration-factory.js";

const MANAGE_SUBCOMMANDS = new Set(["close", "delete", "edit"]);

/**
 * Flags that consume the next argv token as their value. Used by the
 * positional-extraction logic so `--group engineering` doesn't treat
 * `engineering` as a candidate for the body. Adding a new value-flag here
 * is required for it to work — there is no implicit detection.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--root",
  "--name",
  "--agent",
  "--group",
  "--body-file",
]);

/**
 * Boolean flags (no value). Combined with VALUE_FLAGS to form the full set
 * of recognized flags. Anything else starting with `--` is rejected.
 */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["--all", "--list"]);

/** Compute the local-provider path for a directive item by id. Local
 *  items live as YAML frontmatter markdown files under
 *  `<rootDir>/.murmuration/items/<id>.{json,md}`. Returns the first
 *  match or `undefined` when no file exists. */
const localItemPath = (rootDir: string, id: string): string | undefined => {
  const itemsDir = join(rootDir, ".murmuration", "items");
  for (const ext of ["json", "md"] as const) {
    const candidate = join(itemsDir, `${id}.${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

export const runDirective = async (args: readonly string[], rootDir: string): Promise<void> => {
  const root = resolve(rootDir);

  // -------------------------------------------------------------------
  // Manage subcommands — close / delete / edit — handled first so they
  // don't fall through to the scope-required create path. The
  // subcommand may appear anywhere in argv (after `--root <path>` etc.),
  // so we scan for the first known verb rather than trusting args[0].
  // -------------------------------------------------------------------
  const verbIdx = args.findIndex((a) => MANAGE_SUBCOMMANDS.has(a));
  if (verbIdx >= 0) {
    const verb = args[verbIdx] ?? "";
    const id = args[verbIdx + 1];
    if (!id || id.startsWith("--")) {
      throw new Error(`murmuration directive ${verb}: <id> is required`);
    }

    if (verb === "close") {
      let provider;
      try {
        ({ provider } = await buildCollaborationProvider(root));
      } catch (err) {
        if (err instanceof CollaborationBuildError) {
          throw new Error(`murmuration directive close: ${err.message}`, { cause: err });
        }
        throw err;
      }
      const result = await provider.updateItemState({ id }, "closed");
      if (!result.ok) {
        throw new Error(
          `${provider.displayName} error: ${result.error.code} — ${result.error.message}`,
        );
      }
      console.log(`Directive ${id} closed.`);
      return;
    }

    // delete and edit are local-provider-only — both operate on the
    // on-disk JSON file directly. GitHub doesn't support true delete
    // (only close), and editing a GitHub issue on the CLI is better
    // served by `gh issue edit`.
    const path = localItemPath(root, id);
    if (!path) {
      throw new Error(
        `murmuration directive ${verb}: directive "${id}" not found in .murmuration/items/ ` +
          `(${verb} works with the local collaboration provider; for GitHub use 'gh issue ${verb === "delete" ? "close" : "edit"}')`,
      );
    }

    if (verb === "delete") {
      await unlink(path);
      console.log(`Directive ${id} deleted.`);
      return;
    }

    // edit
    const editor = process.env.EDITOR ?? "vi";
    const cp = await import("node:child_process");
    cp.spawnSync(editor, [path], { stdio: "inherit" });
    return;
  }

  // -------------------------------------------------------------------
  // Reject unknown flags before doing anything else. Unknown flags used
  // to be silently ignored, which caused `--body-file <path>` to drop
  // through to the positional-body extractor and post a directive whose
  // body was the value of whichever flag happened to come last (e.g. a
  // deadline date). Failing fast here is cheap and avoids posting
  // malformed directives that agents then file TENSIONs about.
  // -------------------------------------------------------------------
  const unknownFlags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg?.startsWith("--")) continue;
    if (VALUE_FLAGS.has(arg)) {
      i++; // consume value
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) continue;
    unknownFlags.push(arg);
  }
  if (unknownFlags.length > 0) {
    throw new Error(
      `murmuration directive: unrecognized flag(s): ${unknownFlags.join(", ")}. ` +
        `Supported flags: ${[...VALUE_FLAGS, ...BOOLEAN_FLAGS].sort().join(", ")}.`,
    );
  }

  // -------------------------------------------------------------------
  // Scope determination for create / list
  // -------------------------------------------------------------------
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
    throw new Error(
      "murmuration directive: specify --agent <id>, --group <id>, --all, --list, or a manage " +
        "subcommand (close / delete / edit)",
    );
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

  // Body source: --body-file <path> (preferred for multi-line content)
  // OR the last true positional argument. The previous implementation
  // built positionals as `args.filter(a => !a.startsWith("--"))`, which
  // mistakenly treated value-of-flag tokens (e.g. the `engineering` after
  // `--group`) as candidates and led to silent data loss when callers
  // passed unrecognized flags carrying their real body content.
  const bodyFileIdx = args.indexOf("--body-file");
  let body: string | undefined;
  if (bodyFileIdx >= 0) {
    const bodyFilePath = args[bodyFileIdx + 1];
    if (!bodyFilePath || bodyFilePath.startsWith("--")) {
      throw new Error("murmuration directive: --body-file requires a path argument");
    }
    try {
      body = (await readFile(bodyFilePath, "utf-8")).trim();
    } catch (err) {
      throw new Error(
        `murmuration directive: failed to read --body-file ${bodyFilePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
  } else {
    // Walk argv, skipping flags and their values; collect true positionals.
    const positionals: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === undefined) continue;
      if (arg.startsWith("--")) {
        if (VALUE_FLAGS.has(arg)) i++; // skip value
        continue;
      }
      positionals.push(arg);
    }
    body = positionals.pop();
  }
  if (body === undefined || body.length === 0) {
    throw new Error(
      "murmuration directive: provide a message body via positional argument " +
        "or --body-file <path>",
    );
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

  // Title: first non-empty line of the body, capped at 80 chars. Multi-line
  // bodies (typical with --body-file) would otherwise produce a title with
  // embedded newlines from a naive slice.
  const titleSource = body.split("\n").find((line) => line.trim().length > 0) ?? body;
  const createResult = await provider.createItem({
    title: `[DIRECTIVE] ${titleSource.trim().slice(0, 80)}`,
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
