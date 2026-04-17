/**
 * Shared factory for building a {@link CollaborationProvider} from a
 * murmuration root directory. Used by the `directive`, `backlog`, and
 * `group-wake` CLI commands so they all honor the same
 * `collaboration.provider` config resolution as the daemon boot path.
 *
 * Resolution order:
 *   1. `harness.yaml` → `collaboration.provider` + `collaboration.repo`
 *   2. Agent `role.md` → `signals.github_scopes[0]` (fallback repo)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  IdentityLoader,
  LocalCollaborationProvider,
  GitHubCollaborationProvider,
  makeSecretKey,
  type CollaborationProvider,
} from "@murmurations-ai/core";
import { createGithubClient, makeRepoCoordinate } from "@murmurations-ai/github";
import { DotenvSecretsProvider } from "@murmurations-ai/secrets-dotenv";

import { loadHarnessConfig } from "./harness-config.js";

const GITHUB_TOKEN = makeSecretKey("GITHUB_TOKEN");

export interface RepoCoord {
  readonly owner: string;
  readonly repo: string;
}

/** Read the target repo — first from harness.yaml, then from agent signal scopes. */
export const findDefaultRepo = async (rootDir: string): Promise<RepoCoord | null> => {
  try {
    const config = await loadHarnessConfig(rootDir);
    if (config.collaboration.repo) {
      const parts = config.collaboration.repo.split("/");
      if (parts.length === 2 && parts[0] && parts[1]) {
        return { owner: parts[0], repo: parts[1] };
      }
    }
  } catch {
    /* no harness.yaml — try agent scopes */
  }

  try {
    const loader = new IdentityLoader({ rootDir });
    const agentIds = await loader.discover();
    for (const agentId of agentIds) {
      try {
        const identity = await loader.load(agentId);
        const scopes = identity.frontmatter.signals.github_scopes;
        if (scopes && scopes.length > 0 && scopes[0]) {
          return { owner: scopes[0].owner, repo: scopes[0].repo };
        }
      } catch {
        /* skip agents that can't be loaded */
      }
    }
  } catch {
    /* skip */
  }
  return null;
};

export interface BuiltCollaboration {
  readonly provider: CollaborationProvider;
  /** Repo coordinate, only set when using the GitHub provider. */
  readonly repo?: RepoCoord;
}

export class CollaborationBuildError extends Error {
  public constructor(
    public readonly code: "MISSING_ENV" | "MISSING_REPO" | "MISSING_TOKEN",
    message: string,
  ) {
    super(message);
    this.name = "CollaborationBuildError";
  }
}

/**
 * Build a {@link CollaborationProvider} for a CLI command.
 *
 * - Local mode: returns a {@link LocalCollaborationProvider} scoped to
 *   `.murmuration/items/` under the root directory. No secrets needed.
 * - GitHub mode (default): loads `GITHUB_TOKEN` from `.env`, resolves the
 *   target repo from `harness.yaml` (falling back to agent scopes), and
 *   returns a {@link GitHubCollaborationProvider}.
 *
 * Throws {@link CollaborationBuildError} on configuration problems so
 * callers can produce command-specific error messages.
 */
export const buildCollaborationProvider = async (
  rootDir: string,
  opts: { readonly writeScopesRepos?: readonly string[] } = {},
): Promise<BuiltCollaboration> => {
  const config = await loadHarnessConfig(rootDir);

  if (config.collaboration.provider === "local") {
    const provider = new LocalCollaborationProvider({
      itemsDir: join(rootDir, ".murmuration", "items"),
      artifactsDir: rootDir,
    });
    return { provider };
  }

  const repo = await findDefaultRepo(rootDir);
  if (!repo) {
    throw new CollaborationBuildError(
      "MISSING_REPO",
      "Could not determine target repo. Set collaboration.repo in harness.yaml or configure github_scopes in an agent's role.md.",
    );
  }

  const envPath = join(rootDir, ".env");
  if (!existsSync(envPath)) {
    throw new CollaborationBuildError(
      "MISSING_ENV",
      ".env not found (need GITHUB_TOKEN for the GitHub collaboration provider).",
    );
  }

  const secretsProvider = new DotenvSecretsProvider({ envPath });
  await secretsProvider.load({ required: [GITHUB_TOKEN], optional: [] });
  if (!secretsProvider.has(GITHUB_TOKEN)) {
    throw new CollaborationBuildError(
      "MISSING_TOKEN",
      "GITHUB_TOKEN not present in .env for the GitHub collaboration provider.",
    );
  }

  const repoKey = `${repo.owner}/${repo.repo}`;
  const writeScopesRepos = opts.writeScopesRepos ?? [repoKey];
  const client = createGithubClient({
    token: secretsProvider.get(GITHUB_TOKEN),
    writeScopes: {
      issueComments: [...writeScopesRepos],
      branchCommits: [],
      labels: [...writeScopesRepos],
      issues: [...writeScopesRepos],
    },
  });

  const provider = new GitHubCollaborationProvider({
    client,
    repo: makeRepoCoordinate(repo.owner, repo.repo),
  });

  return { provider, repo };
};
