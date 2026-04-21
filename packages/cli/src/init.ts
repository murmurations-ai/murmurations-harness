/**
 * `murmuration init` — interactive scaffolding for a new murmuration.
 *
 * Creates a directory structure the daemon can boot against:
 *
 *   <target>/
 *     murmuration/
 *       soul.md              — murmuration purpose + bright lines
 *       harness.yaml         — runtime config (governance, etc.)
 *     agents/
 *       <agent-name>/
 *         soul.md            — agent identity
 *         role.md            — frontmatter + accountabilities
 *     governance/
 *       groups/
 *         <group>.md         — group context (if any groups declared)
 *     .env                   — secret placeholders (0600)
 *     .gitignore             — ignores .env, .murmuration/
 *
 * The init interview is minimal — ask a few questions, produce maximum
 * scaffolding with inline comments guiding later hand-edits.
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile, readFile, appendFile, chmod, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

import { humanizeSlug } from "@murmurations-ai/core";

import { buildBuiltinProviderRegistry } from "./builtin-providers/index.js";
import {
  captureSecret,
  GITHUB_TOKEN_SPEC,
  LLM_KEY_SPECS,
  type KnownProvider,
} from "./init-secrets.js";

// DO NOT create readline at module scope — it grabs stdin and corrupts
// terminal mode for other commands (e.g., attach REPL double echo).
let rl: Interface | null = null;

// Completions active for the current ask() call. The readline
// completer reads this at TAB time; ask() sets it before question()
// and clears it after the answer arrives. Lets us reuse one readline
// Interface across prompts with prompt-specific completion lists.
let activeCompletions: readonly string[] | null = null;

const getRL = (): Interface => {
  rl ??= createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string): [string[], string] => {
      if (!activeCompletions) return [[], line];
      const lower = line.toLowerCase();
      const hits = activeCompletions.filter((c) => c.toLowerCase().startsWith(lower));
      // Empty input / no prefix match → show the full menu.
      return [hits.length > 0 ? hits : [...activeCompletions], line];
    },
  });
  return rl;
};

const ask = (question: string, completions?: readonly string[]): Promise<string> =>
  new Promise((r) => {
    activeCompletions = completions ?? null;
    getRL().question(question, (answer) => {
      activeCompletions = null;
      r(answer);
    });
  });

/**
 * Wrap a {@link captureSecret} call so it doesn't fight with the
 * init-flow readline. An active readline keeps its own stdin data
 * listener, which echoes raw keystrokes AND steals the ENTER meant
 * for the echo-off prompt — manifesting as a plaintext-echoed key
 * and a consumed confirmation ENTER. Tear down the readline before
 * the capture; lazy `getRL()` re-creates a fresh one on the next
 * `ask()`.
 *
 * Tester report (v0.5.0): `murmuration init` echoed the Gemini API
 * key in plaintext and then "crashed" (actually: readline consumed
 * the confirmation ENTER, hanging the prompt).
 */
const captureSecretIsolated = async (
  args: Parameters<typeof captureSecret>[0],
): Promise<string> => {
  rl?.close();
  rl = null;
  return captureSecret(args);
};

// ---------------------------------------------------------------------------
// Default-agent templates
// ---------------------------------------------------------------------------

/** Resolve the shipped default-agent templates directory. When the CLI
 *  is running from its published `dist/`, templates live next to the
 *  compiled JS at `dist/default-agent/`. When running from source
 *  (tests, `pnpm dev`), the compiled entry point and the templates
 *  under `src/default-agent/` sit at the same relative offset. */
const resolveDefaultAgentTemplatesDir = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const shipped = join(here, "default-agent");
  if (existsSync(shipped)) return shipped;
  // Source-tree fallback for `pnpm -C packages/cli run dev`-style execution.
  return join(here, "..", "src", "default-agent");
};

// ---------------------------------------------------------------------------
// Examples — bundled templates copied by `murmuration init --example <name>`.
// v0.5.0 Milestone 4. A new operator can run
//   `murmuration init --example hello my-test-dir`
// and watch a meeting happen in under 5 minutes.
// ---------------------------------------------------------------------------

/**
 * Resolve the shipped examples directory. Mirrors the dist/src
 * resolution of default-agent templates — dist/examples/ in published
 * packages, src/examples/ when running from source.
 */
const resolveExamplesDir = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const shipped = join(here, "examples");
  if (existsSync(shipped)) return shipped;
  return join(here, "..", "src", "examples");
};

/**
 * Resolve the bundled S3 governance plugin shipped with the CLI.
 * v0.5.0 Milestone 4.6: S3 (and any future governance plugins we
 * author) ship with the CLI so operators don't need to install or
 * author them from scratch. Copied into the scaffolded murmuration
 * at init time so the repo is self-contained.
 */
const resolveBundledS3Plugin = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const shipped = join(here, "governance-plugins", "s3", "index.mjs");
  if (existsSync(shipped)) return shipped;
  return join(here, "..", "src", "governance-plugins", "s3", "index.mjs");
};

/**
 * Short-name → canonical-directory aliases for `--example`. Lets the
 * operator type the docs-friendly name (`hello`) and get the full
 * bundled directory (`hello-circle`). Safe to extend as new examples
 * ship.
 */
const EXAMPLE_ALIASES: Readonly<Record<string, string>> = {
  hello: "hello-circle",
};

/**
 * Resolve a user-supplied `--example <name>` to the canonical example
 * directory. Accepts both aliases (`hello`) and exact directory names
 * (`hello-circle`). Returns null if neither resolves to a bundled
 * example.
 */
export const resolveExampleName = (name: string): string | null => {
  const examples = listExamples();
  if (examples.includes(name)) return name;
  const aliased = EXAMPLE_ALIASES[name];
  if (aliased && examples.includes(aliased)) return aliased;
  return null;
};

/** List the example names bundled with this CLI. */
export const listExamples = (): readonly string[] => {
  const dir = resolveExamplesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
};

/**
 * Recursively copy the bundled example named `name` into targetDir.
 * Preserves directory structure and file permissions. Silently skips
 * files that collide — bail out at the caller level if that's a
 * problem (v0.5.0 Milestone 2 detection kicks in before we get here).
 */
const copyExample = async (name: string, targetDir: string): Promise<void> => {
  const src = join(resolveExamplesDir(), name);
  if (!existsSync(src)) {
    const available = listExamples();
    throw new Error(
      `No bundled example named "${name}". Available: ${available.join(", ") || "(none)"}`,
    );
  }
  await copyDirRecursive(src, targetDir);
};

const copyDirRecursive = async (src: string, dest: string): Promise<void> => {
  await mkdir(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
};

const copyDefaultAgentTemplates = async (destDir: string): Promise<void> => {
  const src = resolveDefaultAgentTemplatesDir();
  for (const file of ["soul.md", "role.md"] as const) {
    const srcPath = join(src, file);
    if (!existsSync(srcPath)) continue;
    await copyFile(srcPath, join(destDir, file));
  }
};

// ---------------------------------------------------------------------------
// .gitignore preflight (#10)
// ---------------------------------------------------------------------------

/** Ensure `.gitignore` in `targetDir` lists every requested entry.
 *  Creates the file when absent; appends only missing lines when
 *  present. Never overwrites — preserves whatever rules the operator
 *  has already curated for the target repo. Matching is exact (per
 *  line, trimmed) so near-misses like `.env*` do NOT satisfy `.env`. */
const ensureGitignoreCovers = async (
  targetDir: string,
  entries: readonly string[],
): Promise<void> => {
  const path = join(targetDir, ".gitignore");
  if (!existsSync(path)) {
    await writeFile(path, entries.join("\n") + "\n", "utf8");
    return;
  }
  const current = await readFile(path, "utf8");
  const existingLines = new Set(current.split("\n").map((l) => l.trim()));
  const toAdd = entries.filter((e) => !existingLines.has(e));
  if (toAdd.length === 0) return;
  const prefix = current.endsWith("\n") ? "" : "\n";
  await appendFile(path, `${prefix}${toAdd.join("\n")}\n`, "utf8");
};

// ---------------------------------------------------------------------------
// Agent question helper
// ---------------------------------------------------------------------------

interface AgentAnswers {
  readonly name: string;
  readonly dir: string;
  readonly provider: string;
  readonly group: string;
  readonly schedule: string;
}

const VALID_PROVIDERS = new Set(["gemini", "anthropic", "openai", "ollama"]);

const normalizeProvider = (input: string, fallback: string): string => {
  const v = input.trim().toLowerCase();
  if (!v) return fallback;
  return VALID_PROVIDERS.has(v) ? v : fallback;
};

const askAgentQuestions = async (
  isFirst: boolean,
  defaultProvider: string,
): Promise<AgentAnswers> => {
  const namePrompt = isFirst
    ? "Name your first agent (e.g. research, coordinator, builder): "
    : "Agent name: ";
  const name = await ask(namePrompt);
  const dir = name.trim().toLowerCase().replace(/\s+/g, "-");

  const providerInput = await ask(
    `  LLM provider override (gemini / anthropic / openai / ollama) [${defaultProvider}]: `,
    ["gemini", "anthropic", "openai", "ollama"],
  );
  const provider = normalizeProvider(providerInput, defaultProvider);

  const groupInput = await ask("  Group this agent belongs to (or Enter for none): ");
  const group = groupInput.trim().toLowerCase().replace(/\s+/g, "-") || "";

  // Daily is the default: a 2-second delay wakes every agent on
  // startup which burns tokens fast on a many-agent fabric. Daily at
  // 9am UTC is a safer out-of-the-box cadence; operators can edit
  // role.md for anything more aggressive.
  const scheduleInput = await ask("  Wake schedule (daily / hourly / custom cron) [daily]: ", [
    "daily",
    "hourly",
  ]);
  const schedule = scheduleInput.trim().toLowerCase() || "daily";

  return { name: name.trim(), dir, provider, group, schedule };
};

/**
 * Resolve the interactive key-capture spec for a given LLM provider.
 * Returns null for `ollama` (locally hosted; no key) and for unknown
 * providers (no interactive capture — the operator edits .env by hand).
 */
const getLLMKeySpec = (
  provider: string,
): (typeof LLM_KEY_SPECS)[keyof typeof LLM_KEY_SPECS] | null => {
  if (provider === "gemini" || provider === "anthropic" || provider === "openai") {
    return LLM_KEY_SPECS[provider satisfies Exclude<KnownProvider, "ollama">];
  }
  return null;
};

/**
 * What kind of murmuration layout (if any) lives at targetDir.
 * Used to tell the operator what they're about to run against so they
 * don't accidentally overwrite half-migrated work. v0.5.0 Milestone 2.
 */
export type ExistingStateKind =
  | "empty-or-missing"
  | "current" // ADR-0026 compliant (murmuration/ + agents/)
  | "legacy-circles" // governance/circles/ predating ADR-0026
  | "partial"; // some ADR-0026 pieces but missing either murmuration/ or agents/

export interface ExistingStateInfo {
  readonly kind: ExistingStateKind;
  /** Specific signals that informed the classification. */
  readonly signals: readonly string[];
}

export const detectExistingState = (targetDir: string): ExistingStateInfo => {
  if (!existsSync(targetDir)) {
    return { kind: "empty-or-missing", signals: ["directory does not exist"] };
  }
  const hasMurmurationDir = existsSync(join(targetDir, "murmuration"));
  const hasAgentsDir = existsSync(join(targetDir, "agents"));
  const hasCirclesDir = existsSync(join(targetDir, "governance", "circles"));
  const hasGroupsDir = existsSync(join(targetDir, "governance", "groups"));

  const signals: string[] = [];
  if (hasMurmurationDir) signals.push("murmuration/ present");
  if (hasAgentsDir) signals.push("agents/ present");
  if (hasCirclesDir) signals.push("governance/circles/ present (pre-ADR-0026)");
  if (hasGroupsDir) signals.push("governance/groups/ present (ADR-0026)");

  if (!hasMurmurationDir && !hasAgentsDir && !hasCirclesDir && !hasGroupsDir) {
    return {
      kind: "empty-or-missing",
      signals: signals.length > 0 ? signals : ["no murmuration/governance artifacts found"],
    };
  }
  if (hasCirclesDir && !hasGroupsDir) {
    return { kind: "legacy-circles", signals };
  }
  if (hasMurmurationDir && hasAgentsDir) {
    return { kind: "current", signals };
  }
  return { kind: "partial", signals };
};

const formatScheduleYaml = (schedule: string): string => {
  if (schedule === "" || schedule === "daily") return 'cron: "0 9 * * *"  # daily at 9am UTC';
  if (schedule === "hourly") return 'cron: "0 * * * *"  # every hour';
  if (schedule.includes("*") || schedule.includes("/")) return `cron: "${schedule}"`;
  // Unknown input — fall back to daily rather than a chatty 2s delay.
  return 'cron: "0 9 * * *"  # daily at 9am UTC (edit to tune)';
};

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------

/**
 * Best-effort read of the example's `murmuration/harness.yaml` to
 * figure out which LLM provider it uses. Used by runInitFromExample
 * to prompt for the right `<PROVIDER>_API_KEY`. Defaults to "gemini"
 * on any parse or read failure — harmless, since captureSecret's
 * shape validation will reject a pasted wrong-provider key.
 */
const detectExampleProvider = async (targetDir: string): Promise<string> => {
  const harnessPath = join(targetDir, "murmuration", "harness.yaml");
  if (!existsSync(harnessPath)) return "gemini";
  try {
    const content = await readFile(harnessPath, "utf8");
    const match = /^llm:\s*\n\s*provider:\s*["']?([a-z]+)["']?/m.exec(content);
    return match?.[1] ?? "gemini";
  } catch {
    return "gemini";
  }
};

/**
 * Replace a single `KEY=value` line in an existing .env file, or
 * append it if absent. Preserves surrounding comments and ordering.
 * Writes with 0600 in case the caller changed the mode in the interim.
 */
const writeEnvKey = async (envPath: string, key: string, value: string): Promise<void> => {
  let current = "";
  if (existsSync(envPath)) {
    current = await readFile(envPath, "utf8");
  }
  const keyPattern = new RegExp(`^${key.replace(/[^A-Z0-9_]/g, "")}=.*$`, "m");
  const newLine = `${key}=${value}`;
  const next = keyPattern.test(current)
    ? current.replace(keyPattern, newLine)
    : current.trimEnd() + (current.length > 0 ? "\n" : "") + newLine + "\n";
  await writeFile(envPath, next, "utf8");
  await chmod(envPath, 0o600);
};

/**
 * Non-interactive init from a bundled example. Copies the example's
 * directory tree into targetDir, materializes `.env` from the
 * example's `.env.example` (0600), optionally captures the LLM API
 * key interactively, and prints a hero-command block.
 * v0.5.0 Milestones 4 + 4.5.
 *
 * UX goal: from 6 commands to 4 for the tester path. Operator runs
 * `murmuration init --example hello`, pastes a key at the prompt
 * (or presses ENTER to paste later), and is ready to run `doctor`.
 */
export const runInitFromExample = async (
  example: string,
  targetArg: string | undefined,
): Promise<void> => {
  const resolvedExample = resolveExampleName(example);
  if (!resolvedExample) {
    const available = [...new Set([...listExamples(), ...Object.keys(EXAMPLE_ALIASES)])].sort();
    console.error(
      `murmuration init: no example named "${example}". Available: ${available.join(", ") || "(none)"}`,
    );
    throw new Error(`unknown example: ${example}`);
  }
  // From here on, use the canonical directory name.
  example = resolvedExample;

  const target = targetArg ?? `my-${example}-murmuration`;
  const targetDir = resolve(target);

  const existingState = detectExistingState(targetDir);
  if (existingState.kind !== "empty-or-missing") {
    console.error(
      `murmuration init: ${targetDir} already exists; refusing to overwrite an example scaffold.`,
    );
    console.error(
      `  Remove the directory first, or pass a fresh target path: \`murmuration init --example ${example} some-other-dir\`.`,
    );
    throw new Error(`target directory not empty: ${targetDir}`);
  }

  await copyExample(example, targetDir);

  // v0.5.0 Milestone 4.5: materialize .env from .env.example at 0600
  // so the operator doesn't have to `cp .env.example .env && chmod 600 .env`.
  // Then offer to capture the LLM key interactively — same UX as
  // interactive init. If they skip, .env still carries the placeholder
  // and doctor will flag it.
  const envExamplePath = join(targetDir, ".env.example");
  const envPath = join(targetDir, ".env");
  if (existsSync(envExamplePath) && !existsSync(envPath)) {
    await copyFile(envExamplePath, envPath);
    await chmod(envPath, 0o600);
  }

  // Determine the provider the example uses (best-effort read of
  // its harness.yaml). Default to gemini when we can't tell.
  const exampleProvider = await detectExampleProvider(targetDir);
  const llmSpec = getLLMKeySpec(exampleProvider);
  let capturedKey = "";
  // Only attempt interactive capture when we have a real TTY.
  // In CI, tests, or piped input the prompt would hang; the operator
  // can always edit .env by hand later.
  if (llmSpec && process.stdin.isTTY) {
    console.log(
      `\nLet's capture your ${llmSpec.displayName} API key now so you can run a meeting right away.\nInput is masked; press ENTER to skip and paste it into .env later.`,
    );
    capturedKey = await captureSecretIsolated({ spec: llmSpec, askYN: ask });
    if (capturedKey) {
      await writeEnvKey(envPath, llmSpec.envVar, capturedKey);
    }
  }

  rl?.close();

  const sessionName = targetDir.split("/").pop() ?? "murmuration";
  try {
    const { registerSession } = await import("./sessions.js");
    registerSession(sessionName, targetDir);
  } catch {
    // sessions module may not be available in all contexts
  }

  const capturedNote = capturedKey
    ? `\n  ✓ ${llmSpec?.envVar ?? "API key"} captured into .env (0600). You can run doctor and group-wake immediately.\n`
    : `\n  ⚠ No key captured. Edit .env before running any command.\n`;

  const editStep = capturedKey
    ? ""
    : `  # edit .env and paste your ${llmSpec?.envVar ?? "API key"} (https://aistudio.google.com/apikey)\n\n`;

  console.log(`
✓ Copied example "${example}" to ${targetDir}
  Registered as "${sessionName}".
${capturedNote}
Try it now:

  cd ${target}
${editStep}  murmuration doctor --name ${sessionName}
  murmuration group-wake --name ${sessionName} --group example --directive "what should we scout next?"
`);
};

export interface RunInitOptions {
  /** Positional target dir. If omitted, the interactive prompt asks. */
  readonly targetArg?: string;
  /** If set, bypass the interactive interview and copy the named example. */
  readonly example?: string;
}

export const runInit = async (optionsOrTargetArg?: RunInitOptions | string): Promise<void> => {
  const options: RunInitOptions =
    typeof optionsOrTargetArg === "string"
      ? { targetArg: optionsOrTargetArg }
      : (optionsOrTargetArg ?? {});
  const { targetArg, example } = options;

  if (example !== undefined) {
    await runInitFromExample(example, targetArg);
    return;
  }

  const providerRegistry = buildBuiltinProviderRegistry();
  console.log("\nmurmuration init — create a new murmuration\n");

  // 1. Target directory
  const target = targetArg ?? (await ask("Directory to create (e.g. ../my-murmuration): "));
  const targetDir = resolve(target.trim());

  // v0.5.0 Milestone 2: detect existing state so the operator knows what
  // they're about to run against before anything is overwritten.
  const existingState = detectExistingState(targetDir);
  if (existingState.kind !== "empty-or-missing") {
    console.log(`\n${targetDir} already exists.`);
    for (const signal of existingState.signals) {
      console.log(`  - ${signal}`);
    }
    let warning = "";
    switch (existingState.kind) {
      case "current":
        warning =
          "This looks like a current (ADR-0026) murmuration. Running init here will overwrite files.";
        break;
      case "legacy-circles":
        warning =
          "This looks like a pre-ADR-0026 murmuration (governance/circles/). Running init here will overwrite files. A migration tool is planned (see ADR-0026).";
        break;
      case "partial":
        warning =
          "This looks like a partially-initialized murmuration. Running init here will overwrite any files it generates.";
        break;
      default:
        break;
    }
    console.log(`\n${warning}`);
    const existing = await ask(`Continue anyway? (y/N): `, ["yes", "no"]);
    if (existing.trim().toLowerCase() !== "y") {
      console.log("Aborted.");
      rl?.close();
      return;
    }
  }

  // 2. Murmuration purpose
  const purpose = await ask("What is this murmuration's purpose? (one sentence): ");

  // 3. Default LLM provider (harness-level). Agents + the Spirit inherit this
  //    unless an agent's role.md or a spirit.md (Phase 2) overrides.
  const defaultProviderInput = await ask(
    "Default LLM provider (gemini / anthropic / openai / ollama) [gemini]: ",
    ["gemini", "anthropic", "openai", "ollama"],
  );
  const defaultProvider = normalizeProvider(defaultProviderInput, "gemini");

  // 3a. Capture the LLM API key interactively (v0.5.0 Milestone 2).
  //     Writes to .env at the end; empty string = operator skipped and
  //     will populate .env by hand.
  const capturedSecrets = new Map<string, string>();
  const llmSpec = getLLMKeySpec(defaultProvider);
  if (llmSpec) {
    console.log(
      `\nLet's capture your ${llmSpec.displayName} API key. Input is masked; press ENTER to skip.`,
    );
    const key = await captureSecretIsolated({ spec: llmSpec, askYN: ask });
    if (key) capturedSecrets.set(llmSpec.envVar, key);
  } else {
    console.log(`\nOllama is locally-hosted — no API key needed.`);
  }

  // 4. Collaboration & Products
  const collabInput = await ask("\nCollaboration provider (github / local) [github]: ", [
    "github",
    "local",
  ]);
  const collaboration = collabInput.trim().toLowerCase() === "local" ? "local" : "github";

  let githubOwner = "";
  let githubRepoName = "";
  if (collaboration === "github") {
    const githubInput = await ask("GitHub repo (e.g. org/repo, or Enter to skip): ");
    const githubRepo = githubInput.trim();
    if (githubRepo.includes("/")) {
      const parts = githubRepo.split("/");
      githubOwner = parts[0] ?? "";
      githubRepoName = parts[1] ?? "";
    }

    // 4a. Capture GITHUB_TOKEN (v0.5.0 Milestone 2).
    console.log(
      `\nLet's capture your GitHub personal access token. It needs "repo" scope. Input is masked; press ENTER to skip.`,
    );
    const token = await captureSecretIsolated({ spec: GITHUB_TOKEN_SPEC, askYN: ask });
    if (token) capturedSecrets.set(GITHUB_TOKEN_SPEC.envVar, token);
  }

  const productInput = await ask(
    "External product workspace (e.g. /home/user/vault or org/repo, or Enter to skip): ",
  );
  const productPath = productInput.trim();

  // 5. Agents
  const agents: AgentAnswers[] = [];
  agents.push(await askAgentQuestions(true, defaultProvider));

  let addMore = await ask("\nAdd another agent? (y/N): ", ["yes", "no"]);
  while (addMore.trim().toLowerCase() === "y") {
    agents.push(await askAgentQuestions(false, defaultProvider));
    addMore = await ask("\nAdd another agent? (y/N): ", ["yes", "no"]);
  }

  // 5. Governance model
  // Default: self-organizing (Sociocracy 3.0). The S3 plugin ships with
  // the CLI and is copied into the scaffolded repo below, so this works
  // out of the box. Operators who want something else can pick from
  // the menu; those plugins still need to be authored separately.
  const govInput = await ask(
    "\nGovernance model (self-organizing / chain-of-command / meritocratic / consensus / parliamentary / none) [self-organizing]: ",
    ["self-organizing", "chain-of-command", "meritocratic", "consensus", "parliamentary", "none"],
  );
  const governance = govInput.trim().toLowerCase() || "self-organizing";

  rl?.close();

  // -------------------------------------------------------------------
  // Write the files
  // -------------------------------------------------------------------

  console.log(`\nCreating murmuration at ${targetDir}...\n`);

  // Collect all groups
  const groups = [...new Set(agents.map((a) => a.group).filter(Boolean))];

  // Directories
  await mkdir(join(targetDir, "murmuration"), { recursive: true });
  await mkdir(join(targetDir, "murmuration", "default-agent"), { recursive: true });
  for (const agent of agents) {
    await mkdir(join(targetDir, "agents", agent.dir), { recursive: true });
  }
  if (groups.length > 0) {
    await mkdir(join(targetDir, "governance", "groups"), { recursive: true });
  }

  // Copy default-agent templates. These are used by IdentityLoader (ADR-0027)
  // when an agent directory is missing soul.md / role.md. Shipping a copy
  // into the operator's murmuration makes the defaults discoverable and
  // editable — operators tune the fallback character by hand rather than
  // through CLI flags.
  await copyDefaultAgentTemplates(join(targetDir, "murmuration", "default-agent"));

  // If local collaboration, remove the github MCP tool from the default agent role.md
  if (collaboration === "local") {
    const defaultRolePath = join(targetDir, "murmuration", "default-agent", "role.md");
    if (existsSync(defaultRolePath)) {
      const roleContent = await readFile(defaultRolePath, "utf8");
      const stripped = roleContent.replace(
        /tools:\n {2}mcp:\n {4}- name: github\n {6}command: npx\n {6}args: \["-y", "@modelcontextprotocol\/server-github"\]\n {6}env:\n {8}GITHUB_TOKEN: "\$GITHUB_TOKEN"\n/g,
        "",
      );
      await writeFile(defaultRolePath, stripped);
    }
  }

  // murmuration/soul.md
  await writeFile(
    join(targetDir, "murmuration", "soul.md"),
    `# Murmuration Soul

## Purpose

${purpose.trim()}

## Bright lines

_Define the non-negotiable principles every agent in this murmuration must follow._

- (add your bright lines here)

## Values

_What does this murmuration optimize for?_

- (add your values here)
`,
    "utf8",
  );

  // murmuration/harness.yaml
  // v0.5.0 Milestone 4.6: the S3 plugin ships bundled with the CLI and
  // is copied into murmuration/governance-s3/ on init. The plugin path
  // in harness.yaml is relative so the scaffolded repo is self-contained
  // (no npm install of an external plugin package needed).
  let governancePluginPath = "";
  if (governance === "self-organizing") {
    governancePluginPath = "./murmuration/governance-s3/index.mjs";
    await mkdir(join(targetDir, "murmuration", "governance-s3"), { recursive: true });
    await copyFile(
      resolveBundledS3Plugin(),
      join(targetDir, "murmuration", "governance-s3", "index.mjs"),
    );
  } else if (governance !== "none") {
    // Other models don't ship a bundled plugin yet — leave a reference
    // to a conventional npm package name the operator can install.
    const placeholders: Record<string, string> = {
      "chain-of-command": "@murmurations-ai/governance-command",
      meritocratic: "@murmurations-ai/governance-meritocratic",
      consensus: "@murmurations-ai/governance-consensus",
      parliamentary: "@murmurations-ai/governance-parliamentary",
    };
    governancePluginPath = placeholders[governance] ?? governance;
  }
  const governanceBlock =
    governance !== "none"
      ? `governance:\n  model: "${governance}"\n  plugin: "${governancePluginPath}"`
      : `governance:\n  model: none`;

  const collabBlock =
    collaboration === "github" && githubOwner
      ? `collaboration:\n  provider: "${collaboration}"\n  repo: "${githubOwner}/${githubRepoName}"`
      : `collaboration:\n  provider: "${collaboration}"`;

  const productName = productPath.split("/").pop() ?? "workspace";
  const productBlock = productPath
    ? `\n\nproducts:\n  - name: "${productName}"\n    repo: "${productPath}"`
    : "";
  await writeFile(
    join(targetDir, "murmuration", "harness.yaml"),
    `# Murmuration Harness configuration
# This file is read by the daemon at boot.

# Default LLM for agents and the Spirit of the Murmuration.
# Agents may override via their role.md 'llm:' frontmatter.
llm:
  provider: "${defaultProvider}"

${governanceBlock}

${collabBlock}${productBlock}
`,
    "utf8",
  );

  // Write each agent
  const secretNames = new Set<string>();
  for (const agent of agents) {
    // soul.md
    await writeFile(
      join(targetDir, "agents", agent.dir, "soul.md"),
      `# ${agent.name} — Soul

## Who I am

_Describe this agent's character, perspective, and approach._

## What I will never do

_Define the agent-specific bright lines beyond the murmuration soul._
`,
      "utf8",
    );

    // role.md
    const keyName = providerRegistry.envKeyName(agent.provider);
    const secretName = typeof keyName === "string" ? keyName : "";
    if (secretName) secretNames.add(secretName);
    const groupLine = agent.group ? `\n  - "${agent.group}"` : "";
    const ghScopes = githubOwner
      ? `
  github_scopes:
    - owner: "${githubOwner}"
      repo: "${githubRepoName}"`
      : "";
    const writeScopes = githubOwner
      ? `
    issue_comments: ["${githubOwner}/${githubRepoName}"]
    branch_commits:
      - repo: "${githubOwner}/${githubRepoName}"
        paths: ["**"]
    labels: ["${githubOwner}/${githubRepoName}"]
    issues: ["${githubOwner}/${githubRepoName}"]`
      : `
    issue_comments: []
    branch_commits: []
    labels: []
    issues: []`;

    // Engineering Standard #11 — emit only fields the operator explicitly
    // chose or that differ from schema/cascade defaults. Omitted fields
    // inherit: agent_id from dir; name humanized from dir; model_tier
    // "balanced"; soul_file "soul.md"; llm from harness.yaml.
    const llmOverride =
      agent.provider !== defaultProvider ? `\nllm:\n  provider: "${agent.provider}"\n` : "";

    await writeFile(
      join(targetDir, "agents", agent.dir, "role.md"),
      `---
# Minimum-viable frontmatter. Anything omitted inherits reasonable
# defaults per docs/ARCHITECTURE.md Engineering Standard #11:
#   agent_id    → directory name ("${agent.dir}")
#   name        → humanized directory ("${humanizeSlug(agent.dir)}")
#   model_tier  → "balanced"
#   soul_file   → "soul.md"
#   llm         → inherits murmuration/harness.yaml
# Uncomment any line to override.

max_wall_clock_ms: 120000
group_memberships:${groupLine || "\n  []"}
${llmOverride}
wake_schedule:
  ${formatScheduleYaml(agent.schedule)}

signals:
  sources:${collaboration === "github" ? '\n    - "github-issue"' : ""}
    - "private-note"${ghScopes}

github:
  write_scopes:${writeScopes}

budget:
  max_cost_micros: 100000
  max_github_api_calls: 10
  on_breach: "warn"

secrets:
  required: [${secretName ? `"${secretName}"` : ""}]
  ${collaboration === "github" ? '\n  optional: ["GITHUB_TOKEN"]' : ""}

# MCP tools and OpenClaw plugins. Empty = none.
tools:
  mcp: []

plugins: []
---

# ${agent.name} — Role

## Accountabilities

1. _(define what this agent is responsible for)_

## Decision tiers

- **Autonomous:** _(what this agent can do without asking)_
- **Notify:** _(what requires notification to Source)_
- **Consent:** _(what requires group consent)_
`,
      "utf8",
    );
  }

  // Group docs
  for (const group of groups) {
    const members = agents.filter((a) => a.group === group).map((a) => a.dir);
    await writeFile(
      join(targetDir, "governance", "groups", `${group}.md`),
      `# ${group.charAt(0).toUpperCase() + group.slice(1)} Group

## Purpose

_Define this group's purpose._

## Members

${members.map((m) => `- ${m}`).join("\n")}
`,
      "utf8",
    );
  }

  // .gitignore — preflight BEFORE writing .env so secrets are never
  // uncovered on disk even for a moment. If a .gitignore already
  // exists (e.g. running init against an existing repo), append
  // only the missing entries instead of overwriting.
  await ensureGitignoreCovers(targetDir, [".env", ".env.*", "!.env.example", ".murmuration/"]);

  // v0.5.0 Milestone 2: .env uses captured secrets when available,
  // placeholder when the operator skipped. .env.example ships the
  // same keys with empty values so operators committing the repo have
  // a template to share.
  const secretNamesToDeclare = new Set<string>(secretNames);
  if (githubOwner) secretNamesToDeclare.add("GITHUB_TOKEN");
  const orderedSecretNames = [...secretNamesToDeclare].sort();

  const envLines: string[] = [];
  for (const name of orderedSecretNames) {
    const captured = capturedSecrets.get(name) ?? "";
    if (captured) {
      envLines.push(`${name}=${captured}`);
    } else if (name === "GITHUB_TOKEN" && !githubOwner) {
      envLines.push(`# ${name}=ghp_your-token-here`);
    } else {
      envLines.push(`${name}=your-api-key-here`);
    }
  }
  const envPath = join(targetDir, ".env");
  await writeFile(envPath, envLines.join("\n") + "\n", "utf8");
  await chmod(envPath, 0o600);

  // .env.example — commit-friendly template. Never carries captured values.
  const envExampleLines: string[] = [
    "# Copy to .env and fill in. Never commit .env — .gitignore covers it.",
    "# Permissions: chmod 600 .env",
    "",
  ];
  for (const name of orderedSecretNames) {
    envExampleLines.push(`${name}=`);
  }
  await writeFile(join(targetDir, ".env.example"), envExampleLines.join("\n") + "\n", "utf8");

  // Register session
  const sessionName = targetDir.split("/").pop() ?? "murmuration";
  try {
    const { registerSession } = await import("./sessions.js");
    registerSession(sessionName, targetDir);
  } catch {
    // sessions module may not be available in all contexts
  }

  // -------------------------------------------------------------------
  // Print next steps
  // -------------------------------------------------------------------

  // v0.5.0 Milestone 2: lead with the hero command a tester runs next.
  // Optional per-agent tuning hints follow; no step-by-step chore list.
  const firstGroup = groups[0];
  const heroCommand = firstGroup
    ? `  murmuration group-wake --name ${sessionName} --group ${firstGroup}\n`
    : `  murmuration start --name ${sessionName}\n`;

  const capturedSecretsSummary = [...capturedSecrets.keys()].sort();
  const capturedHint =
    capturedSecretsSummary.length > 0
      ? `  ✓ Captured: ${capturedSecretsSummary.join(", ")} (written to .env at 0600)\n`
      : `  ⚠ No secrets captured — edit .env before running any command.\n`;

  const governanceNote =
    governance !== "none"
      ? `\n  Governance plugin: ${governancePluginPath || governance} (configured in murmuration/harness.yaml)`
      : "";

  console.log(`
✓ Murmuration initialized at ${targetDir}
  Registered as "${sessionName}".${governanceNote}

${capturedHint}
Try it now:

  murmuration doctor --name ${sessionName}   # validate the setup
${heroCommand}
Next:

  - Edit agents/<id>/soul.md and role.md to flesh out each agent's voice
  - Edit governance/groups/<id>.md to flesh out each group's domain
  - Edit murmuration/default-agent/{soul,role}.md to tune fallback identity
`);
};
