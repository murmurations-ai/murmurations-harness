/**
 * `murmuration doctor` — preflight diagnosis of a murmuration repo.
 * v0.5.0 Milestone 3.
 *
 * Runs a battery of checks against a root directory and tells the
 * operator what will (or won't) work. `--fix` attempts safe
 * auto-remediations (backing up originals to `.bak`). `--live` opts
 * into provider API calls to verify secrets actually authenticate.
 * `--json` emits machine-readable results for CI or monitoring.
 *
 * Designed to be the one-stop setup validator: after `init`, run
 * `doctor`; before filing a bug, run `doctor`; after migrating a
 * legacy repo, run `doctor --fix`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { access, constants, readFile, writeFile, chmod, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  FrontmatterInvalidError,
  IdentityFileMissingError,
  IdentityLoader,
} from "@murmurations-ai/core";

import { listBundledPluginAliases, probeGovernancePlugin } from "./governance-plugin-resolver.js";
import { loadHarnessConfig, validateHarnessYaml, type HarnessConfig } from "./harness-config.js";

const which = (bin: string): boolean => {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DoctorCategory = "layout" | "schema" | "secrets" | "governance" | "live" | "drift";

export type DoctorSeverity = "error" | "warning" | "info";

export interface DoctorFinding {
  readonly checkId: string;
  readonly category: DoctorCategory;
  readonly severity: DoctorSeverity;
  readonly title: string;
  /** Additional context (file path, field, etc.). */
  readonly detail?: string;
  /** Human instructions for a manual fix. */
  readonly remediation?: string;
  /** If set, `--fix` will call this function. */
  readonly autoFix?: () => Promise<void>;
  /** Label shown next to the finding when --fix would handle it. */
  readonly autoFixLabel?: string;
}

export interface DoctorReport {
  readonly rootDir: string;
  readonly findings: readonly DoctorFinding[];
  /** Categories skipped (e.g. "live" when --live omitted). */
  readonly skipped: readonly DoctorCategory[];
  /** ISO timestamp. */
  readonly checkedAt: string;
}

export interface DoctorOptions {
  readonly rootDir: string;
  readonly live?: boolean;
  readonly fix?: boolean;
  readonly json?: boolean;
}

interface CheckContext {
  readonly rootDir: string;
  readonly harness: HarnessConfig;
  readonly findings: DoctorFinding[];
}

// ---------------------------------------------------------------------------
// Category 1: Layout (ADR-0026)
// ---------------------------------------------------------------------------

const runLayoutChecks = async (ctx: CheckContext): Promise<void> => {
  const { rootDir, findings, harness } = ctx;

  const requireDir = (relPath: string, severity: DoctorSeverity, reason: string): void => {
    const full = join(rootDir, relPath);
    if (!existsSync(full)) {
      findings.push({
        checkId: `layout.${relPath.replaceAll("/", ".")}.missing`,
        category: "layout",
        severity,
        title: `${relPath}/ is missing`,
        detail: reason,
        remediation: `Run \`murmuration init\` against this directory, or create \`${relPath}/\` manually.`,
      });
    }
  };

  requireDir(
    "murmuration",
    "error",
    "every operator repo needs a murmuration/ directory per ADR-0026",
  );
  requireDir("agents", "error", "no agents/ means nothing to wake");

  // murmuration/harness.yaml: exists + parses
  const harnessPath = join(rootDir, "murmuration", "harness.yaml");
  if (existsSync(join(rootDir, "murmuration")) && !existsSync(harnessPath)) {
    findings.push({
      checkId: "layout.harness-yaml.missing",
      category: "layout",
      severity: "warning",
      title: "murmuration/harness.yaml is missing",
      detail:
        "Defaults will be used (Gemini, info logging, no governance plugin, GitHub collaboration).",
      remediation: `Generate via \`murmuration init\`, or author a minimal harness.yaml by hand.`,
    });
  }

  // murmuration/soul.md
  if (
    existsSync(join(rootDir, "murmuration")) &&
    !existsSync(join(rootDir, "murmuration", "soul.md"))
  ) {
    findings.push({
      checkId: "layout.soul.missing",
      category: "layout",
      severity: "error",
      title: "murmuration/soul.md is missing",
      detail: "The harness identity loader requires this file as the shared constitutional layer.",
      remediation: `Create murmuration/soul.md with your murmuration's purpose and bright lines.`,
    });
  }

  // murmuration/default-agent/{soul,role}.md (ADR-0027)
  for (const file of ["soul.md", "role.md"] as const) {
    const p = join(rootDir, "murmuration", "default-agent", file);
    if (existsSync(join(rootDir, "murmuration")) && !existsSync(p)) {
      findings.push({
        checkId: `layout.default-agent.${file}.missing`,
        category: "layout",
        severity: "warning",
        title: `murmuration/default-agent/${file} is missing`,
        detail: "ADR-0027 fallback identity template won't kick in for empty agent dirs.",
        remediation: `Copy the default-agent templates from \`murmuration init\` output, or run init against a scratch dir and copy.`,
      });
    }
  }

  // .gitignore covers .env
  const gitignorePath = join(rootDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    findings.push({
      checkId: "layout.gitignore.missing",
      category: "layout",
      severity: "warning",
      title: ".gitignore missing",
      detail: ".env could be committed accidentally.",
      remediation: `Create .gitignore with \`.env\`, \`.env.*\`, \`!.env.example\`, \`.murmuration/\`.`,
      autoFix: async () => {
        await writeFile(
          gitignorePath,
          ".env\n.env.*\n!.env.example\n.murmuration/\n.DS_Store\n",
          "utf8",
        );
      },
      autoFixLabel: "create .gitignore with standard entries",
    });
  } else {
    const gi = await readFile(gitignorePath, "utf8");
    const lines = gi.split("\n").map((l) => l.trim());
    const missing: string[] = [];
    for (const expected of [".env", ".murmuration/"]) {
      if (!lines.includes(expected)) missing.push(expected);
    }
    if (missing.length > 0) {
      findings.push({
        checkId: "layout.gitignore.incomplete",
        category: "layout",
        severity: "warning",
        title: `.gitignore missing entries: ${missing.join(", ")}`,
        remediation: `Append ${missing.join(", ")} to .gitignore.`,
        autoFix: async () => {
          const prefix = gi.endsWith("\n") ? "" : "\n";
          await writeFile(gitignorePath, gi + prefix + missing.join("\n") + "\n", "utf8");
        },
        autoFixLabel: `append ${missing.join(", ")} to .gitignore`,
      });
    }
  }

  // murmuration CLI binary — if not on PATH, subprocess spawn will fail (#329)
  if (!which("murmuration")) {
    findings.push({
      checkId: "layout.murmuration-binary.missing",
      category: "layout",
      severity: "warning",
      title: "`murmuration` binary not found on PATH",
      detail:
        "Agents that use a subprocess executor will fail with spawn-failed. This is expected in development (run via `pnpm exec murmuration`), but in production the binary must be globally installed.",
      remediation: `Run \`npm install -g @murmurations-ai/cli\` or ensure \`node_modules/.bin\` is on PATH.`,
    });
  }

  // subscription-CLI binary reachability (harness#XXX)
  // launchd / cron start daemons with a minimal PATH that may omit ~/.local/bin,
  // causing ENOENT on every cron wake. Doctor catches this at setup time.
  if (harness.llm.provider === "subscription-cli" && harness.llm.cli) {
    const cliName = harness.llm.cli;
    const fallbackPaths: readonly string[] =
      cliName === "claude"
        ? [
            join(homedir(), ".local", "bin", "claude"),
            "/usr/local/bin/claude",
            "/opt/homebrew/bin/claude",
            join(homedir(), ".npm", "bin", "claude"),
            join(homedir(), "node_modules", ".bin", "claude"),
          ]
        : cliName === "gemini"
          ? [
              join(homedir(), ".local", "bin", "gemini"),
              "/usr/local/bin/gemini",
              "/opt/homebrew/bin/gemini",
              join(homedir(), ".npm", "bin", "gemini"),
            ]
          : [
              join(homedir(), ".local", "bin", "codex"),
              "/usr/local/bin/codex",
              "/opt/homebrew/bin/codex",
              join(homedir(), ".npm", "bin", "codex"),
              join(homedir(), ".openai", "bin", "codex"),
            ];

    let absoluteCliPath: string | undefined;
    try {
      absoluteCliPath = execFileSync("which", [cliName], { encoding: "utf8" }).trim() || undefined;
    } catch {
      /* not in PATH — try fallback locations */
    }
    const inPath = absoluteCliPath !== undefined;
    if (!inPath) {
      for (const p of fallbackPaths) {
        try {
          await access(p, constants.X_OK);
          absoluteCliPath = p;
          break;
        } catch {
          /* try next */
        }
      }
    }

    if (!absoluteCliPath) {
      findings.push({
        checkId: `layout.cli-binary.${cliName}.missing`,
        category: "layout",
        severity: "error",
        title: `CLI binary "${cliName}" not found`,
        detail: `harness.yaml configures provider: subscription-cli / cli: ${cliName}, but the binary was not found on PATH or in common install locations (${fallbackPaths.join(", ")}). Every agent wake will fail with spawn ENOENT.`,
        remediation: `Install the CLI: e.g. \`npm install -g @anthropic-ai/claude-code\` for claude. After installing, run \`doctor\` again to confirm.`,
      });
    } else if (!inPath) {
      findings.push({
        checkId: `layout.cli-binary.${cliName}.not-in-path`,
        category: "layout",
        severity: "warning",
        title: `CLI binary "${cliName}" found at ${absoluteCliPath} but not on PATH`,
        detail: `The daemon will resolve "${cliName}" to "${absoluteCliPath}" via its fallback search, but launchd / cron environments may not have this path in PATH. The harness resolves the binary at boot time, so daemon wakes will work — but interactive \`${cliName}\` commands from the terminal may fail if PATH is not set correctly.`,
        remediation: `Add the directory containing "${cliName}" to your shell PATH (e.g. add \`export PATH="$HOME/.local/bin:$PATH"\` to ~/.zshrc).`,
      });
    }
  }

  // .env permissions
  const envPath = join(rootDir, ".env");
  if (existsSync(envPath)) {
    const mode = statSync(envPath).mode & 0o777;
    if (mode !== 0o600) {
      findings.push({
        checkId: "layout.env.mode",
        category: "layout",
        severity: "warning",
        title: `.env is mode ${mode.toString(8)} (expected 600)`,
        detail: "Your .env is readable by other users on this machine.",
        remediation: `Run \`chmod 600 .env\`.`,
        autoFix: async () => {
          await chmod(envPath, 0o600);
        },
        autoFixLabel: "chmod 600 .env",
      });
    }
  }
};

// ---------------------------------------------------------------------------
// Category 2: Schema (ADR-0016)
// ---------------------------------------------------------------------------

const runSchemaChecks = async (ctx: CheckContext): Promise<void> => {
  const { rootDir, findings, harness } = ctx;

  // harness.yaml Zod validation (#323)
  const harnessWarnings = await validateHarnessYaml(rootDir);
  for (const w of harnessWarnings) {
    const safePath = w.field.replaceAll(/\W+/g, "_");
    findings.push({
      checkId: `schema.harness-yaml.${safePath}`,
      category: "schema",
      severity: "warning",
      title: `murmuration/harness.yaml: ${w.field} — ${w.message}`,
      detail: `Received: ${w.received}${w.accepted !== undefined ? `; accepted: ${w.accepted.join(", ")}` : ""}`,
      remediation: `Edit murmuration/harness.yaml and correct the \`${w.field}\` field.`,
    });
  }

  const agentsDir = join(rootDir, "agents");
  if (!existsSync(agentsDir)) return;

  const loader = new IdentityLoader({
    rootDir,
    roleDefaults: {
      llm: {
        provider: harness.llm.provider,
        ...(harness.llm.model !== undefined ? { model: harness.llm.model } : {}),
        ...(harness.llm.cli !== undefined ? { cli: harness.llm.cli } : {}),
        ...(harness.llm.permissionMode !== undefined
          ? { permissionMode: harness.llm.permissionMode }
          : {}),
      },
    },
  });

  const agentDirs = await loader.discover();
  if (agentDirs.length === 0) {
    findings.push({
      checkId: "schema.no-agents",
      category: "schema",
      severity: "warning",
      title: "No agents/<slug>/role.md files found",
      detail: "Nothing for the daemon to spawn.",
      remediation: "Create at least one agent directory with a role.md.",
    });
    return;
  }

  // agentDeclaredGroups collects each agent's self-declared group_memberships
  // for the bidirectional membership consistency check (#238).
  const agentDeclaredGroups = new Map<string, readonly string[]>();

  for (const slug of agentDirs) {
    try {
      const identity = await loader.load(slug);
      // Operational completeness checks (#236): flag configuration that is
      // syntactically valid but operationally hollow.
      const fm = identity.frontmatter;
      const sources = fm.signals.sources;
      const githubScopes = fm.signals.github_scopes ?? [];
      agentDeclaredGroups.set(slug, fm.group_memberships);
      // Only flag the github-issue-without-scopes gap when the harness
      // collaboration provider is "github" — a local-provider setup has no
      // GitHub signals regardless of the sources default, so it's not a bug.
      if (
        harness.collaboration.provider === "github" &&
        sources.includes("github-issue") &&
        githubScopes.length === 0
      ) {
        findings.push({
          checkId: `schema.role.${slug}.github-issue-source-without-scopes`,
          category: "schema",
          severity: "error",
          title: `agents/${slug}: signals.sources includes "github-issue" but signals.github_scopes is empty`,
          detail: `Agent will be wake-blind to GitHub — signal aggregator will return [] on every wake.`,
          remediation: `Add signals.github_scopes in agents/${slug}/role.md with owner, repo, and filter to route GitHub issues to this agent.`,
        });
      }
      if (sources.length === 0) {
        findings.push({
          checkId: `schema.role.${slug}.no-signal-sources`,
          category: "schema",
          severity: "warning",
          title: `agents/${slug}: signals.sources is empty — agent will receive no signals`,
          detail: `Agent will wake on its cron schedule but see no action items.`,
          remediation: `Add signals.sources (e.g. "github-issue", "private-note") in agents/${slug}/role.md.`,
        });
      }
    } catch (err) {
      if (err instanceof FrontmatterInvalidError) {
        for (const issue of err.issues) {
          const remediation = issue.includes(" — ")
            ? issue.split(" — ").slice(1).join(" — ")
            : undefined;
          findings.push({
            checkId: `schema.role.${slug}.${issue.slice(0, 40).replaceAll(/\W+/g, "_")}`,
            category: "schema",
            severity: "error",
            title: `agents/${slug}/role.md: ${issue.split(" — ")[0] ?? issue}`,
            detail: `File: ${err.path}`,
            ...(remediation !== undefined ? { remediation } : {}),
          });
        }
      } else if (err instanceof IdentityFileMissingError) {
        findings.push({
          checkId: `schema.missing.${slug}`,
          category: "schema",
          severity: "error",
          title: `agents/${slug}: required identity file missing`,
          detail: err.message,
        });
      } else {
        findings.push({
          checkId: `schema.load.${slug}.unknown`,
          category: "schema",
          severity: "error",
          title: `agents/${slug}/role.md: failed to load`,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Groups
  const groupsDir = join(rootDir, "governance", "groups");
  if (!existsSync(groupsDir)) return;

  const groupFiles: string[] = [];
  for (const entry of await readdir(groupsDir)) {
    if (entry.endsWith(".md")) groupFiles.push(entry);
  }

  for (const groupFile of groupFiles) {
    const p = join(groupsDir, groupFile);
    const content = await readFile(p, "utf8");
    const membersMatch = /## Members\n([\s\S]*?)(?=\n##|\n---|\n$)/i.exec(content);
    if (!membersMatch) {
      findings.push({
        checkId: `schema.group.${groupFile}.no-members`,
        category: "schema",
        severity: "warning",
        title: `governance/groups/${groupFile}: no \`## Members\` section`,
        detail: "group-wake can't resolve facilitator or members without this.",
        remediation: `Add a \`## Members\` section with bullet-list entries matching agents/<slug>/ directory names.`,
      });
      continue;
    }
    const members: string[] = [];
    for (const line of membersMatch[1]?.split("\n") ?? []) {
      const m = /^\s*-\s*(.+)/.exec(line);
      if (m) members.push(m[1]!.trim());
    }
    if (members.length === 0) {
      findings.push({
        checkId: `schema.group.${groupFile}.empty-members`,
        category: "schema",
        severity: "warning",
        title: `governance/groups/${groupFile}: \`## Members\` is empty`,
        remediation: "Add at least one member (an agents/<slug>/ directory name) as a bullet.",
      });
    } else {
      for (const member of members) {
        if (!agentDirs.includes(member)) {
          findings.push({
            checkId: `schema.group.${groupFile}.unknown-member.${member}`,
            category: "schema",
            severity: "warning",
            title: `governance/groups/${groupFile}: member "${member}" has no agents/${member}/ directory`,
            remediation: `Either create agents/${member}/role.md or remove "${member}" from the Members list.`,
          });
        }
      }
    }

    // Bidirectional membership consistency (#238): each member listed here
    // must also declare this group in their role.md group_memberships.
    const groupId = groupFile.replace(/\.md$/, "");
    for (const member of members) {
      if (!agentDirs.includes(member)) continue; // already flagged above
      const declaredGroups = agentDeclaredGroups.get(member);
      if (declaredGroups !== undefined && !declaredGroups.includes(groupId)) {
        findings.push({
          checkId: `schema.group.${groupFile}.membership-consistency.${member}`,
          category: "schema",
          severity: "error",
          title: `governance/groups/${groupFile}: member "${member}" is not in their role.md group_memberships`,
          detail: `"${member}" is listed in the group file's ## Members but their role.md declares group_memberships: [${declaredGroups.join(", ")}].`,
          remediation: `Add "${groupId}" to agents/${member}/role.md group_memberships, or remove "${member}" from governance/groups/${groupFile}.`,
        });
      }
    }

    // Reverse direction: agents claiming this group in role.md but not listed here.
    for (const [agentSlug, groups] of agentDeclaredGroups) {
      if (groups.includes(groupId) && !members.includes(agentSlug)) {
        findings.push({
          checkId: `schema.group.${groupFile}.membership-consistency.missing-${agentSlug}`,
          category: "schema",
          severity: "error",
          title: `agents/${agentSlug} declares group_memberships includes "${groupId}" but is not listed in governance/groups/${groupFile}`,
          detail: `"${agentSlug}" will receive ${groupId}-routed signals but won't be invited to group-wake meetings.`,
          remediation: `Add "${agentSlug}" to the ## Members list in governance/groups/${groupFile}, or remove "${groupId}" from agents/${agentSlug}/role.md group_memberships.`,
        });
      }
    }

    const facMatch = /facilitator:\s*"?([^"\n]+)"?/i.exec(content);
    if (!facMatch) {
      findings.push({
        checkId: `schema.group.${groupFile}.no-facilitator`,
        category: "schema",
        severity: "info",
        title: `governance/groups/${groupFile}: no \`facilitator:\` declared`,
        detail: "group-wake will default to the first member.",
        remediation: `Add \`facilitator: <agent-slug>\` on its own line.`,
      });
    } else {
      const facilitator = facMatch[1]!.trim();
      if (!agentDirs.includes(facilitator)) {
        findings.push({
          checkId: `schema.group.${groupFile}.facilitator-missing`,
          category: "schema",
          severity: "error",
          title: `governance/groups/${groupFile}: facilitator "${facilitator}" has no agents/${facilitator}/ directory`,
          remediation: `Either create the agent or change facilitator: to an existing agent slug.`,
        });
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Category 3: Secrets
// ---------------------------------------------------------------------------

const parseDotEnv = (content: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
};

const providerKeyName = (provider: string): string | null => {
  switch (provider) {
    case "gemini":
      return "GEMINI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "ollama":
      return null;
    default:
      return null;
  }
};

const runSecretsChecks = async (ctx: CheckContext): Promise<void> => {
  const { rootDir, findings, harness } = ctx;
  const envPath = join(rootDir, ".env");

  if (!existsSync(envPath)) {
    findings.push({
      checkId: "secrets.env.missing",
      category: "secrets",
      severity: "error",
      title: ".env is missing",
      detail: "The daemon will start with no credentials loaded.",
      remediation: `Copy .env.example to .env (\`cp .env.example .env && chmod 600 .env\`) and paste your keys. Or run \`murmuration init\` for an interactive flow.`,
    });
    return;
  }

  const env = parseDotEnv(await readFile(envPath, "utf8"));

  const llmKey = providerKeyName(harness.llm.provider);
  if (llmKey) {
    const value = env.get(llmKey);
    if (!value || value.length === 0 || value === "your-api-key-here") {
      findings.push({
        checkId: `secrets.env.${llmKey}.missing`,
        category: "secrets",
        severity: "error",
        title: `${llmKey} is not set in .env`,
        detail: `The harness default provider is \`${harness.llm.provider}\`; agents that use it will fail to authenticate.`,
        remediation: `Edit .env and paste a ${harness.llm.provider} key. Get one at ${providerKeyUrl(harness.llm.provider)}.`,
      });
    }
  }

  if (harness.collaboration.provider === "github") {
    const token = env.get("GITHUB_TOKEN");
    if (!token || token.length === 0 || token === "ghp_your-token-here") {
      findings.push({
        checkId: "secrets.env.github-token.missing",
        category: "secrets",
        severity: "error",
        title: "GITHUB_TOKEN is not set in .env",
        detail: `collaboration.provider is "github"; no token means every GitHub write will fail.`,
        remediation: `Create a fine-grained PAT at https://github.com/settings/personal-access-tokens with repo scope on ${harness.collaboration.repo ?? "your repo"}, then paste into .env.`,
      });
    }
  }

  if (isTrackedByGit(rootDir, ".env")) {
    findings.push({
      checkId: "secrets.env.tracked",
      category: "secrets",
      severity: "error",
      title: ".env is tracked by git",
      detail: "Anyone with repo access can read your credentials.",
      remediation: `Run \`git rm --cached .env\` and commit, then ensure .gitignore covers .env.`,
    });
  }
};

const providerKeyUrl = (provider: string): string => {
  switch (provider) {
    case "gemini":
      return "https://aistudio.google.com/apikey";
    case "anthropic":
      return "https://console.anthropic.com/settings/keys";
    case "openai":
      return "https://platform.openai.com/api-keys";
    default:
      return "your provider's dashboard";
  }
};

const isTrackedByGit = (rootDir: string, relPath: string): boolean => {
  try {
    const out = execFileSync("git", ["-C", rootDir, "ls-files", "--error-unmatch", relPath], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return out.trim().length > 0;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Category 5: Governance wiring
// ---------------------------------------------------------------------------

const runGovernanceChecks = (ctx: CheckContext): void => {
  const { rootDir, findings, harness } = ctx;
  const plugin = harness.governance.plugin;
  if (plugin === undefined || plugin === "" || plugin === "none") {
    findings.push({
      checkId: "governance.no-plugin",
      category: "governance",
      severity: "info",
      title: "No governance plugin configured",
      detail: "group-wake meetings will run with no state machine (no-op plugin).",
      remediation: `Set \`governance.plugin\` in murmuration/harness.yaml when you're ready to use S3 (or another model).`,
    });
    return;
  }

  // v0.5.0 Milestone 4.7: probe the same resolution order boot.ts uses.
  // If nothing resolves, flag an error with a concrete remediation.
  const probe = probeGovernancePlugin(rootDir, plugin);
  if (probe.kind === "unresolvable") {
    const aliases = listBundledPluginAliases();
    findings.push({
      checkId: "governance.plugin-unresolvable",
      category: "governance",
      severity: "error",
      title: `Governance plugin "${plugin}" cannot be resolved`,
      detail: `Tried: ${probe.attempted.join("; ")}. boot.ts will crash on start.`,
      remediation: `Set \`governance.plugin\` in murmuration/harness.yaml to one of the bundled aliases (${aliases.join(", ")}), a valid relative file path, or an installed npm package name.`,
      autoFix: async () => {
        await rewriteHarnessPlugin(join(rootDir, "murmuration", "harness.yaml"), "s3");
      },
      autoFixLabel: `rewrite governance.plugin to "s3" (bundled)`,
    });
  }
  // bundled-alias / local-path / npm-package → no finding. boot will load.
};

/**
 * Rewrite the `governance.plugin:` line in a harness.yaml to a new
 * value, preserving all other content. Used by `--fix` for the
 * `governance.plugin-unresolvable` finding.
 */
const rewriteHarnessPlugin = async (yamlPath: string, newPlugin: string): Promise<void> => {
  if (!existsSync(yamlPath)) return;
  const content = await readFile(yamlPath, "utf8");
  const pattern = /^(\s*plugin:\s*).*$/m;
  const next = pattern.test(content) ? content.replace(pattern, `$1"${newPlugin}"`) : content;
  if (next !== content) {
    await writeFile(yamlPath, next, "utf8");
  }
};

// ---------------------------------------------------------------------------
// Category 6: Drift / best-practice
// ---------------------------------------------------------------------------

const runDriftChecks = async (ctx: CheckContext): Promise<void> => {
  const { rootDir, findings } = ctx;
  const agentsDir = join(rootDir, "agents");
  if (!existsSync(agentsDir)) return;

  let todoCount = 0;
  for (const slug of await readdir(agentsDir)) {
    const rolePath = join(agentsDir, slug, "role.md");
    if (!existsSync(rolePath)) continue;
    const content = await readFile(rolePath, "utf8");
    const matches = content.match(/TODO:/g);
    if (matches) todoCount += matches.length;
  }
  if (todoCount > 0) {
    findings.push({
      checkId: "drift.todo-count",
      category: "drift",
      severity: "info",
      title: `${String(todoCount)} TODO marker(s) in agent role.md files`,
      detail: "Non-blocking; refine as each agent is actually dispatched.",
    });
  }
};

// ---------------------------------------------------------------------------
// Category 4: Live credential validation
// ---------------------------------------------------------------------------

const withTimeout = async <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        reject(new Error(`timed out (${String(ms)}ms): ${what}`));
      }, ms),
    ),
  ]);
};

const runLiveChecks = async (ctx: CheckContext): Promise<void> => {
  const { rootDir, findings, harness } = ctx;
  const envPath = join(rootDir, ".env");
  if (!existsSync(envPath)) return;
  const env = parseDotEnv(await readFile(envPath, "utf8"));

  // LLM provider validation
  const llmKey = providerKeyName(harness.llm.provider);
  if (llmKey) {
    const token = env.get(llmKey);
    if (token && token.length > 0 && token !== "your-api-key-here") {
      try {
        await validateLLMKey(harness.llm.provider, token);
      } catch (err) {
        findings.push({
          checkId: `live.${llmKey}.invalid`,
          category: "live",
          severity: "error",
          title: `${llmKey} failed live validation`,
          detail: err instanceof Error ? err.message : String(err),
          remediation: `Double-check the key at ${providerKeyUrl(harness.llm.provider)}.`,
        });
      }
    }
  }

  // GitHub token validation
  if (harness.collaboration.provider === "github") {
    const token = env.get("GITHUB_TOKEN");
    if (token && token.length > 0 && token !== "ghp_your-token-here") {
      try {
        const res = await withTimeout(
          fetch("https://api.github.com/user", {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "murmuration-doctor",
            },
          }),
          5000,
          "GitHub GET /user",
        );
        if (!res.ok) {
          findings.push({
            checkId: "live.github-token.invalid",
            category: "live",
            severity: "error",
            title: `GITHUB_TOKEN rejected by GitHub (${String(res.status)})`,
            detail: `Response: ${res.statusText}`,
            remediation: `Regenerate the token at https://github.com/settings/personal-access-tokens.`,
          });
        }
      } catch (err) {
        findings.push({
          checkId: "live.github-token.error",
          category: "live",
          severity: "warning",
          title: `Could not reach GitHub to validate GITHUB_TOKEN`,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
};

const validateLLMKey = async (provider: string, token: string): Promise<void> => {
  if (provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(token)}`;
    const res = await withTimeout(fetch(url), 5000, "Gemini GET /models");
    if (!res.ok) throw new Error(`${String(res.status)} ${res.statusText}`);
  } else if (provider === "anthropic") {
    const res = await withTimeout(
      fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": token, "anthropic-version": "2023-06-01" },
      }),
      5000,
      "Anthropic GET /v1/models",
    );
    if (!res.ok) throw new Error(`${String(res.status)} ${res.statusText}`);
  } else if (provider === "openai") {
    const res = await withTimeout(
      fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      5000,
      "OpenAI GET /v1/models",
    );
    if (!res.ok) throw new Error(`${String(res.status)} ${res.statusText}`);
  }
  // ollama: locally hosted, no key — skip
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export const runDoctor = async (options: DoctorOptions): Promise<DoctorReport> => {
  const rootDir = resolve(options.rootDir);
  const harness = await loadHarnessConfig(rootDir);
  const findings: DoctorFinding[] = [];
  const ctx: CheckContext = { rootDir, harness, findings };
  const skipped: DoctorCategory[] = [];

  await runLayoutChecks(ctx);
  await runSchemaChecks(ctx);
  await runSecretsChecks(ctx);
  runGovernanceChecks(ctx);
  await runDriftChecks(ctx);

  if (options.live) {
    await runLiveChecks(ctx);
  } else {
    skipped.push("live");
  }

  return {
    rootDir,
    findings,
    skipped,
    checkedAt: new Date().toISOString(),
  };
};

// ---------------------------------------------------------------------------
// --fix — apply safe auto-remediations then re-run
// ---------------------------------------------------------------------------

export const applyFixes = async (
  report: DoctorReport,
): Promise<{ readonly applied: readonly string[]; readonly skipped: readonly string[] }> => {
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const finding of report.findings) {
    if (!finding.autoFix) {
      continue;
    }
    try {
      // Best-effort .bak: if the finding references a file, back it up.
      // The autoFix implementations themselves handle the copy where it
      // matters; this is belt-and-suspenders for operators who want a
      // rollback story.
      await finding.autoFix();
      applied.push(`${finding.checkId}: ${finding.autoFixLabel ?? "fixed"}`);
    } catch (err) {
      skipped.push(`${finding.checkId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { applied, skipped };
};

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

const CATEGORY_LABEL: Record<DoctorCategory, string> = {
  layout: "Layout",
  schema: "Schema",
  secrets: "Secrets",
  governance: "Governance",
  live: "Live validation",
  drift: "Drift / best-practice",
};

export const formatReport = (report: DoctorReport): string => {
  const lines: string[] = [];
  lines.push(`\nmurmuration doctor — checking ${report.rootDir}\n`);

  const byCategory = new Map<DoctorCategory, DoctorFinding[]>();
  for (const cat of Object.keys(CATEGORY_LABEL) as DoctorCategory[]) {
    byCategory.set(cat, []);
  }
  for (const f of report.findings) {
    byCategory.get(f.category)!.push(f);
  }

  const skippedSet = new Set(report.skipped);
  for (const cat of Object.keys(CATEGORY_LABEL) as DoctorCategory[]) {
    const catFindings = byCategory.get(cat)!;
    if (skippedSet.has(cat)) {
      lines.push(`  ${CATEGORY_LABEL[cat].padEnd(24, ".")} (skipped; pass --live to enable)`);
      continue;
    }
    const errors = catFindings.filter((f) => f.severity === "error").length;
    const warnings = catFindings.filter((f) => f.severity === "warning").length;
    const infos = catFindings.filter((f) => f.severity === "info").length;
    if (errors > 0) {
      lines.push(
        `  ${CATEGORY_LABEL[cat].padEnd(24, ".")} ✗ ${String(errors)} error(s)${warnings > 0 ? `, ${String(warnings)} warning(s)` : ""}`,
      );
    } else if (warnings > 0) {
      lines.push(
        `  ${CATEGORY_LABEL[cat].padEnd(24, ".")} ⚠ ${String(warnings)} warning(s)${infos > 0 ? `, ${String(infos)} info` : ""}`,
      );
    } else if (infos > 0) {
      lines.push(`  ${CATEGORY_LABEL[cat].padEnd(24, ".")} ℹ ${String(infos)} info`);
    } else {
      lines.push(`  ${CATEGORY_LABEL[cat].padEnd(24, ".")} ✓`);
    }
  }
  lines.push("");

  const printSection = (title: string, severity: DoctorSeverity, icon: string): void => {
    const items = report.findings.filter((f) => f.severity === severity);
    if (items.length === 0) return;
    lines.push("─".repeat(60));
    lines.push(`  ${title}`);
    lines.push("─".repeat(60));
    for (const f of items) {
      lines.push(`  ${icon} ${CATEGORY_LABEL[f.category]}: ${f.title}`);
      if (f.detail) lines.push(`     ${f.detail}`);
      if (f.remediation) lines.push(`     Fix: ${f.remediation}`);
      if (f.autoFix) {
        lines.push(
          `     Auto-fix available: \`murmuration doctor --fix\` (${f.autoFixLabel ?? "see check"})`,
        );
      }
      lines.push("");
    }
  };

  printSection("Errors (must fix)", "error", "✗");
  printSection("Warnings", "warning", "⚠");
  printSection("Info", "info", "ℹ");

  const errorCount = report.findings.filter((f) => f.severity === "error").length;
  lines.push("─".repeat(60));
  lines.push(`  Summary`);
  lines.push("─".repeat(60));
  if (errorCount === 0) {
    lines.push("  ✓ No errors. Your murmuration should run.");
  } else {
    lines.push(`  ${String(errorCount)} error(s). murmuration will NOT run correctly until fixed.`);
  }
  lines.push("");
  return lines.join("\n");
};

export const exitCodeFor = (report: DoctorReport): number =>
  report.findings.some((f) => f.severity === "error") ? 1 : 0;

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export const runDoctorCli = async (options: DoctorOptions): Promise<number> => {
  let report = await runDoctor(options);

  if (options.fix) {
    const fixResult = await applyFixes(report);
    if (fixResult.applied.length > 0) {
      console.log(`\nApplied ${String(fixResult.applied.length)} auto-fix(es):`);
      for (const a of fixResult.applied) console.log(`  ✓ ${a}`);
    }
    if (fixResult.skipped.length > 0) {
      console.log(`\n${String(fixResult.skipped.length)} auto-fix(es) skipped:`);
      for (const s of fixResult.skipped) console.log(`  ! ${s}`);
    }
    console.log("\nRe-running checks...");
    report = await runDoctor(options);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          rootDir: report.rootDir,
          checkedAt: report.checkedAt,
          skipped: report.skipped,
          findings: report.findings.map((f) => ({
            checkId: f.checkId,
            category: f.category,
            severity: f.severity,
            title: f.title,
            ...(f.detail !== undefined ? { detail: f.detail } : {}),
            ...(f.remediation !== undefined ? { remediation: f.remediation } : {}),
            autoFixAvailable: f.autoFix !== undefined,
          })),
          errorCount: report.findings.filter((f) => f.severity === "error").length,
          warningCount: report.findings.filter((f) => f.severity === "warning").length,
          infoCount: report.findings.filter((f) => f.severity === "info").length,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(formatReport(report));
  }

  return exitCodeFor(report);
};
