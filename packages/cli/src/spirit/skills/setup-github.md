---
name: setup-github
description: How to guide the operator through setting up GitHub and the MCP token for the murmuration
---

# Setting up GitHub Collaboration

When the operator wants to set up GitHub for their murmuration, guide them through this step-by-step process. Walk them through it iteratively rather than dumping the whole process at once. Wait for them to confirm completion of a step before moving to the next.

## Advising on Architecture Choices

Before starting the setup, ensure the operator understands the tradeoffs they are making:

### Local vs. GitHub Governance

- **Local Governance (`collaboration: local`)**:
  - _Pros_: Completely private, works offline, zero external dependencies, fastest execution, no API limits.
  - _Cons_: Single-player only, hard to audit over time, no native issue tracking or discussion threads, lacks the async handoff benefits of a shared platform.
- **GitHub Governance (`collaboration: github`)**:
  - _Pros_: System of record is external and highly durable, native support for async threads (Issues/PRs), multi-operator/multi-agent transparent, easy to audit agent decisions.
  - _Cons_: Requires network access, API tokens, potential rate limits, requires secure secret management.

### Private vs. Public Repositories

- **CRITICAL: Always recommend a Private repository by default.**
- _Why?_ The governance repository holds agent `role.md` files, internal discussions, and potentially sensitive organizational state. Unless the murmuration is explicitly building an open-source project in public (like Emergent Praxis), public exposure is a severe security and privacy risk.
- _Action:_ Explicitly ask the operator to verify the repo is set to Private before pushing any local state or creating tokens.

## 1. Create the Murmuration Repository

First, the operator needs a GitHub repository to hold the murmuration's state.

- Create a new repository on GitHub (e.g., `my-org/my-murmuration`). Remind them to make it **Private**.
- Clone the repository locally, or if starting from scratch locally:
  ```bash
  mkdir my-murmuration
  cd my-murmuration
  git init
  ```
- Run `murmuration init .` to scaffold the directory. (Or `murmuration init my-murmuration` if they haven't made the folder yet).

## 2. Configure harness.yaml

The harness needs to know which repository to sync with, and it must load the GitHub MCP server so agents have tools to comment and interact with issues.
Instruct the operator to open `murmuration/harness.yaml` and ensure it has:

```yaml
collaboration:
  provider: "github"
  repo: "my-org/my-murmuration" # Replace with their actual repo

mcp:
  servers:
    - name: github
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: "$GITHUB_TOKEN"
```

## 3. Generate a GitHub Token

The agents (and the harness) need a GitHub token to authenticate.

- **Classic Token (Recommended for simplicity):** Go to GitHub Developer Settings -> Personal access tokens -> Tokens (classic). Generate a new token with the `repo` scope selected.
- **Fine-grained Token:** Ensure it has Read/Write access to Issues, Pull Requests, and Metadata for the specific repository.
- Copy the generated token immediately (it starts with `ghp_` or `github_pat_`).

## 4. Set the Token in .env

The harness uses `.env` files to pass secrets.

- In the root of their murmuration workspace, create a file named `.env`.
- Add the token:
  ```
  GITHUB_TOKEN=ghp_... (paste the token here)
  ```

## 5. Verify and Start

- Confirm that the `.env` file is excluded from source control (the `murmuration init` command creates a `.gitignore` that handles this, but it's good to verify).
- Run `murmuration start`.
- The agents will now be able to use the `github` tools securely via MCP and read/write to the GitHub issues for governance.
