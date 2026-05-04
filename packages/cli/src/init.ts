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
import { detectInstalledClis, formatDetectionSummary, type CliPresence } from "./cli-detect.js";
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
// v0.7.0 (Workstream I): facilitator-agent auto-include
// ---------------------------------------------------------------------------

/**
 * Resolve the shipped facilitator-agent template directory. Mirrors
 * the dist/src resolution pattern used by default-agent and examples.
 *
 * Production CLI (`npm install`): `<dist>/facilitator-agent-template/`
 * Source-tree dev (`pnpm -C ... run dev`): two possible roots — the
 * compiled `packages/cli/dist/` will have it, or we fall back to the
 * top-level `examples/facilitator-agent/agents/facilitator-agent/`
 * which is the canonical authoring location.
 */
const resolveFacilitatorTemplateDir = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const shipped = join(here, "facilitator-agent-template");
  if (existsSync(shipped)) return shipped;
  // Source-tree fallback. From packages/cli/src/init.ts, walk up to
  // the monorepo root and into examples/.
  return join(
    here,
    "..",
    "..",
    "..",
    "examples",
    "facilitator-agent",
    "agents",
    "facilitator-agent",
  );
};

/**
 * Inline copy of the facilitation group context. Kept inline rather
 * than copied from `examples/facilitator-agent/governance/groups/`
 * because the group context file is stable + small + needs to land
 * regardless of whether the template-dir resolution succeeds.
 *
 * IdentityLoader treats missing group files as a hard error
 * (packages/core/src/identity/index.ts ~line 780), so this MUST be
 * present whenever the facilitator role.md declares
 * `group_memberships: ["facilitation"]`.
 */
const FACILITATION_GROUP_CONTEXT = `# Group: Facilitation

The facilitator-agent's home group. In single-agent murmurations
this group has one member; in multi-agent murmurations operators may
assign additional facilitators (one per geography, time zone, or
governance domain).

## Domain

- Daily reading of governance-typed issues across the murmuration
- State-machine advancement via the active \`GovernancePlugin\`
- Closure decisions per the harness closure rule table (ADR-0041 §Part 3)
- Decision-log and agreement-registry maintenance
- Daily \`[FACILITATOR LOG]\` synthesis

## Authority surface

- Read all governance-tagged issues across all repos in scope
- Comment on any issue with structured close/transition messages
- Apply/remove labels: \`awaiting:source-close\`, \`closed-stale\`,
  \`closed-superseded\`, \`closed-resolved\`, \`verification-failed\`
- Close issues when closure rule + verification both pass
- Write under \`governance/decisions/\` and \`governance/agreements/\`
- File the daily \`[FACILITATOR LOG]\` issue
- Add \`assigned:\` labels on follow-up issues to queue work for other
  agents

## Bright lines

- The facilitator does not file \`[TENSION]\` issues on behalf of other
  agents. Tensions are the originating agent's voice; the facilitator
  may close one (per closer-rule table) but never authors one.
- The facilitator does not close \`[DIRECTIVE]\` issues. Those are
  Source-only; the facilitator labels \`awaiting:source-close\` and
  notifies Source via the daily log.
- The facilitator does not vote, consent, object, or otherwise hold
  a governance position. It is procedural, not deliberative.

## Members

- \`facilitator-agent\` (cron: 07:00 + 18:00 daily)
`;

/**
 * Idempotently copy the facilitator-agent template into the target
 * murmuration's `agents/facilitator-agent/` directory and ensure the
 * facilitation group context file exists.
 *
 * Skip-if-present: if the operator has already initialized this
 * murmuration once, or has hand-edited an existing facilitator-agent,
 * we leave the directory alone and report "already present" so
 * subsequent init runs don't clobber Source's edits. ADR-0041
 * §Part 1: "Source can edit role.md, but facilitator-agent is
 * always present."
 *
 * Exported for testing + for operators who want to add the
 * facilitator-agent to an existing murmuration that was init'd
 * before v0.7.0.
 */
export const copyFacilitatorAgent = async (
  targetRootDir: string,
): Promise<{ readonly action: "copied" | "skipped-existing" | "skipped-no-template" }> => {
  const targetAgentsDir = join(targetRootDir, "agents");
  const dest = join(targetAgentsDir, "facilitator-agent");
  if (existsSync(dest)) return { action: "skipped-existing" };

  const src = resolveFacilitatorTemplateDir();
  if (!existsSync(src)) {
    // Defensive: in unbuilt source trees with no top-level examples
    // directory either (shouldn't happen in published CLI, may happen
    // during incremental build). Don't fail init — just skip.
    return { action: "skipped-no-template" };
  }
  await copyDirRecursive(src, dest);

  // Group context file is required (IdentityLoader hard-errors on
  // missing groups). Write only if it doesn't already exist so an
  // operator who has edited the facilitation group's domain isn't
  // overwritten on subsequent inits.
  const groupsDir = join(targetRootDir, "governance", "groups");
  await mkdir(groupsDir, { recursive: true });
  const groupPath = join(groupsDir, "facilitation.md");
  if (!existsSync(groupPath)) {
    await writeFile(groupPath, FACILITATION_GROUP_CONTEXT, "utf8");
  }
  return { action: "copied" };
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

const VALID_PROVIDERS = new Set(["gemini", "anthropic", "openai", "ollama", "subscription-cli"]);

const normalizeProvider = (input: string, fallback: string): string => {
  const v = input.trim().toLowerCase();
  if (!v) return fallback;
  return VALID_PROVIDERS.has(v) ? v : fallback;
};

/**
 * The init flow's resolved LLM choice. For API providers (gemini /
 * anthropic / openai / ollama), only `provider` matters — model is left
 * to the cascade default. For `subscription-cli`, both `cli` and `model`
 * are required so the harness.yaml + role.md emit a complete config.
 */
interface LlmChoice {
  readonly provider: string;
  readonly cli?: "claude" | "codex" | "gemini";
  readonly model?: string;
}

const askAgentQuestions = async (
  isFirst: boolean,
  defaultProvider: string,
): Promise<AgentAnswers> => {
  const namePrompt = isFirst
    ? "Name your first agent (e.g. research, coordinator, builder): "
    : "Agent name: ";
  const name = await ask(namePrompt);
  const dir = name.trim().toLowerCase().replace(/\s+/g, "-");

  // When default is subscription-cli, agents inherit the cli + model
  // from harness.yaml. Operators rarely override per-agent at init time
  // (it's a downstream tuning task), so keep the prompt simple — just
  // accept the harness default by pressing Enter.
  const overrideOptions =
    defaultProvider === "subscription-cli"
      ? "subscription-cli / gemini / anthropic / openai / ollama"
      : "gemini / anthropic / openai / ollama";
  const overrideCompletions =
    defaultProvider === "subscription-cli"
      ? ["subscription-cli", "gemini", "anthropic", "openai", "ollama"]
      : ["gemini", "anthropic", "openai", "ollama"];
  const providerInput = await ask(
    `  LLM provider override (${overrideOptions}) [${defaultProvider}]: `,
    overrideCompletions,
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
 * Map raw provider input to a complete LLM choice. Handles three forms:
 *
 *   "subscription-cli" + recommended → use recommended CLI's defaults
 *   "subscription-cli/<name>"        → use that CLI's defaults (claude/codex/gemini)
 *   "<api-provider>"                 → API path, no cli/model
 *
 * Empty input falls through to the recommended default if subscription
 * CLIs are present, otherwise to "gemini" for parity with prior behavior.
 */
const resolveLlmChoice = async (
  rawInput: string,
  recommended: CliPresence | null,
  detected: readonly CliPresence[],
): Promise<LlmChoice> => {
  const input = rawInput.trim().toLowerCase();

  // Empty + recommended subscription CLI present → take it.
  if (input === "" && recommended) {
    return {
      provider: "subscription-cli",
      cli: recommended.cli,
      model: recommended.defaultModel,
    };
  }

  // Slash form: subscription-cli/claude or subscription-cli/codex etc.
  if (input.startsWith("subscription-cli/")) {
    const cliName = input.slice("subscription-cli/".length);
    const match = detected.find((c) => c.cli === cliName);
    if (match) {
      return { provider: "subscription-cli", cli: match.cli, model: match.defaultModel };
    }
    // Slash form named an unknown / unavailable CLI — fall through to ask.
  }

  // Plain "subscription-cli" → ask which CLI.
  if (input === "subscription-cli") {
    const available = detected.filter((c) => c.available);
    if (available.length === 0) {
      console.log(
        "  No subscription CLIs detected. Install one of: claude, codex, gemini. Falling back to 'gemini' API.",
      );
      return { provider: "gemini" };
    }
    if (available.length === 1) {
      const only = available[0];
      if (only) {
        return { provider: "subscription-cli", cli: only.cli, model: only.defaultModel };
      }
    }
    const choices = available.map((c) => c.cli).join(" / ");
    const cliInput = await ask(
      `  Which subscription CLI? (${choices}) [${available[0]?.cli ?? "claude"}]: `,
      available.map((c) => c.cli),
    );
    const cliName = cliInput.trim().toLowerCase() || (available[0]?.cli ?? "claude");
    const match = detected.find((c) => c.cli === cliName) ?? available[0];
    if (match) {
      return { provider: "subscription-cli", cli: match.cli, model: match.defaultModel };
    }
  }

  // API path. Empty input + no recommended CLI → "gemini" default.
  const provider = normalizeProvider(input, recommended ? "gemini" : "gemini");
  return { provider };
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
export type ExistingStateKind = "empty-or-missing" | "current" | "partial";

export interface ExistingStateInfo {
  readonly kind: ExistingStateKind;
  readonly signals: readonly string[];
}

export const detectExistingState = (targetDir: string): ExistingStateInfo => {
  if (!existsSync(targetDir)) {
    return { kind: "empty-or-missing", signals: ["directory does not exist"] };
  }
  const hasMurmurationDir = existsSync(join(targetDir, "murmuration"));
  const hasAgentsDir = existsSync(join(targetDir, "agents"));
  const hasGroupsDir = existsSync(join(targetDir, "governance", "groups"));

  const signals: string[] = [];
  if (hasMurmurationDir) signals.push("murmuration/ present");
  if (hasAgentsDir) signals.push("agents/ present");
  if (hasGroupsDir) signals.push("governance/groups/ present");

  if (!hasMurmurationDir && !hasAgentsDir && !hasGroupsDir) {
    return {
      kind: "empty-or-missing",
      signals: signals.length > 0 ? signals : ["no murmuration/governance artifacts found"],
    };
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
    ? `\n  ✓ ${llmSpec?.envVar ?? "API key"} captured into .env (0600). You can run doctor and convene immediately.\n`
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
  murmuration convene --name ${sessionName} --group example --directive "what should we scout next?"
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
          "This looks like an existing murmuration. Running init here will overwrite files.";
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
  //
  //    First: detect installed subscription CLIs (claude / codex / gemini).
  //    If any are present, recommend that route — operators with a Pro/Max
  //    subscription, ChatGPT, or Google subscription can run the murmuration
  //    at $0 marginal cost, no API key required. New-operator unlock.
  const detection = detectInstalledClis();
  if (detection.anyAvailable) {
    console.log(
      `\nDetected subscription CLIs: ${formatDetectionSummary(detection)}` +
        `\nA subscription CLI runs at $0 marginal cost (your existing Pro/Max/ChatGPT/Google subscription).`,
    );
  } else {
    console.log(
      `\nNo subscription CLI detected (claude/codex/gemini). You'll need an API key from one of the providers below.` +
        `\nTip: install Claude Code, ChatGPT/Codex, or Gemini CLI to skip the API-key step entirely.`,
    );
  }

  const defaultLabel = detection.recommended
    ? `subscription-cli/${detection.recommended.cli}`
    : "gemini";
  const promptOptions = detection.anyAvailable
    ? "subscription-cli / gemini / anthropic / openai / ollama"
    : "gemini / anthropic / openai / ollama";
  const completions = detection.anyAvailable
    ? ["subscription-cli", "gemini", "anthropic", "openai", "ollama"]
    : ["gemini", "anthropic", "openai", "ollama"];
  const defaultProviderInput = await ask(
    `Default LLM provider (${promptOptions}) [${defaultLabel}]: `,
    completions,
  );
  const defaultLlmChoice = await resolveLlmChoice(
    defaultProviderInput,
    detection.recommended,
    detection.clis,
  );
  const defaultProvider = defaultLlmChoice.provider;

  // 3a. Capture the LLM API key interactively (v0.5.0 Milestone 2).
  //     Writes to .env at the end; empty string = operator skipped and
  //     will populate .env by hand. Subscription-CLI routes skip this
  //     entirely — auth lives in the CLI's own state.
  const capturedSecrets = new Map<string, string>();
  if (defaultProvider === "subscription-cli") {
    const cli = defaultLlmChoice.cli ?? "claude";
    console.log(
      `\nUsing ${cli} subscription — no API key needed.` +
        ` Verify auth with: ${cli} ${cli === "codex" ? "exec --help" : "--version"}` +
        `\nDefault model: ${defaultLlmChoice.model ?? "(cli default)"}.`,
    );
  } else {
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

  // murmuration/soul.md — reasonable safety defaults so a
  // freshly-scaffolded murmuration doesn't hallucinate on its first
  // meeting. Every agent in the murmuration inherits these. Operators
  // edit as the murmuration's specific constraints become clear.
  await writeFile(
    join(targetDir, "murmuration", "soul.md"),
    `# Murmuration Soul

## Purpose

${purpose.trim()}

## Bright lines

Non-negotiable principles every agent in this murmuration follows:

- **Serve Source.** Source is the human operator and is sovereign — outside the governance graph by design. Never act in Source's name without a directive.
- **Stay grounded.** Do not invent facts, tasks, or decisions that aren't present in your signals, soul, or meeting context. "No contribution this round" is a valid and often correct answer.
- **Respect scopes.** Act only within the \`github.write_scopes\` declared in your role.md frontmatter.
- **Own mistakes.** If you did something wrong, say so plainly. Don't rationalize.

_Edit or extend as murmuration-wide constraints become concrete._

## Values

What this murmuration optimizes for:

- Clarity over volume — concise, concrete contributions beat verbose speculation.
- Traceability — every action should be attributable to a signal, directive, or decision.
- Humility — prefer "I don't know" or "no contribution" over plausible-sounding fabrication.

_Edit to reflect this murmuration's specific priorities._
`,
    "utf8",
  );

  // murmuration/harness.yaml
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
  // Subscription-cli emits cli + model so the daemon has a complete
  // config without forcing the operator to hand-edit. API providers
  // emit only `provider:` and inherit the model from the cascade default.
  const llmYaml =
    defaultLlmChoice.provider === "subscription-cli" && defaultLlmChoice.cli
      ? `llm:
  provider: "subscription-cli"
  cli: "${defaultLlmChoice.cli}"
  model: "${defaultLlmChoice.model ?? ""}"`
      : `llm:
  provider: "${defaultProvider}"`;

  await writeFile(
    join(targetDir, "murmuration", "harness.yaml"),
    `# Murmuration Harness configuration
# This file is read by the daemon at boot.

# Default LLM for agents and the Spirit of the Murmuration.
# Agents may override via their role.md 'llm:' frontmatter.
${llmYaml}

${governanceBlock}

${collabBlock}${productBlock}
`,
    "utf8",
  );

  // Write each agent
  const secretNames = new Set<string>();
  for (const agent of agents) {
    // soul.md — reasonable default voice. Specific enough for the
    // agent to behave sensibly on its first wake; generic enough that
    // the operator will want to edit it as this agent's character
    // becomes clear. Anti-hallucination bright lines are the key part.
    await writeFile(
      join(targetDir, "agents", agent.dir, "soul.md"),
      `# ${agent.name} — Soul

## Who I am

I am ${agent.name}, an agent in this murmuration. I serve Source — the human operator — and contribute to my group's work by observing signals routed to me, responding to directives, and surfacing what I see to the group.

I keep my contributions grounded in the context I actually have: my signals, my role.md accountabilities, the murmuration's soul, and whatever the current meeting or directive asks. When I have nothing concrete to contribute, I say so plainly rather than filling space.

_Edit to give this agent a specific character, perspective, or voice._

## What I will never do

- Invent facts, tasks, or decisions that aren't grounded in my signals, soul, or meeting context.
- Act outside the \`github.write_scopes\` declared in my role.md frontmatter.
- Claim to have done work I haven't actually done.
- Speak for Source or for other agents.

_Extend with agent-specific bright lines as they become clear._
`,
      "utf8",
    );

    // role.md
    const keyName = providerRegistry.envKeyName(agent.provider);
    const secretName = typeof keyName === "string" ? keyName : "";
    if (secretName) secretNames.add(secretName);
    const groupLine = agent.group ? `\n  - "${agent.group}"` : "";
    // Default github_scopes filters on `assigned:<agent-id>` so each
    // agent sees action items directed to it (via GitHub issue labels)
    // without being swamped by unrelated repo traffic. Operators can
    // widen the filter later (e.g. add `group:<id>` label for group-
    // wide tensions). Without these scopes, the signal aggregator has
    // nothing to poll → `signal_count: 0` on every wake → agents can't
    // discover their own assignments. Tester feedback 2026-04-21.
    const ghScopes = githubOwner
      ? `
  github_scopes:
    - owner: "${githubOwner}"
      repo: "${githubRepoName}"
      filter:
        state: "open"
        labels: ["assigned:${agent.dir}"]`
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

1. Observe signals routed to me (see \`signals:\` frontmatter), attend group meetings when convened, and respond to directives from Source.
2. Surface what I see to my group — progress, blockers, open questions — in a form the group can act on.
3. Stay inside my declared write scopes and budget; report when either is about to be exceeded.

_Edit this list as this agent's specific responsibilities become concrete._

## Decision tiers

- **Autonomous:** Answer questions, post meeting contributions, add labels within my declared scope, comment on issues routed to me.
- **Notify:** Opening new issues, commenting outside assigned scope, proposing changes to group membership or domain.
- **Consent:** Changes to group-level policy, scope expansions, any action that affects another agent's domain.

_Edit these tiers to match this agent's specific authority as it becomes clear._
`,
      "utf8",
    );
  }

  // v0.7.0 (Workstream I, ADR-0041): every newly-init'd murmuration
  // gets a facilitator-agent in the box. The default closure-authority
  // agent is what makes the v0.7.0 effectiveness gains land for any
  // operator without per-murmuration setup. Idempotent — never
  // overwrites a Source-edited facilitator from a prior init.
  const facilitatorResult = await copyFacilitatorAgent(targetDir);

  // Group docs
  for (const group of groups) {
    const members = agents.filter((a) => a.group === group).map((a) => a.dir);
    await writeFile(
      join(targetDir, "governance", "groups", `${group}.md`),
      `# ${group.charAt(0).toUpperCase() + group.slice(1)} Group

## Purpose

The ${group} group coordinates the work of its members around the murmuration's purpose: "${purpose.trim() || "(see murmuration/soul.md)"}". Members contribute progress, surface blockers, and reach decisions together in meetings convened by the facilitator.

_Edit this purpose as the group's specific domain becomes concrete._

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
  // Optional per-agent tuning hints follow; no step-by-step chore list.
  const firstGroup = groups[0];
  const heroCommand = firstGroup
    ? `  murmuration convene --name ${sessionName} --group ${firstGroup}\n`
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

  // v0.7.0 (Workstream I): surface the facilitator-agent inclusion
  // so operators know it's there. The agent is opt-in to use (cron
  // is set in role.md); operators can disable by deleting the
  // directory. The closure rules + decision-log writes only happen
  // when the operator points the daemon at a governance plugin.
  const facilitatorNote =
    facilitatorResult.action === "copied"
      ? `\n  ✓ Included facilitator-agent (closure authority — see agents/facilitator-agent/role.md)`
      : facilitatorResult.action === "skipped-existing"
        ? `\n  · facilitator-agent already present (preserved Source edits)`
        : "";

  console.log(`
✓ Murmuration initialized at ${targetDir}
  Registered as "${sessionName}".${governanceNote}${facilitatorNote}

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
