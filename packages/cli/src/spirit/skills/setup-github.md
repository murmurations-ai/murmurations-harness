---
name: setup-github
description: How to guide the operator through setting up GitHub and the MCP token for the murmuration
---

# Setting up GitHub Collaboration

When the operator asks about setting up GitHub, or is unsure how to configure their murmuration's collaboration backend, guide them through a consultative process. Do not dump all the steps at once.

## Phase 1: Consult and Advise (Help them choose)

Before starting any setup, help the operator decide what architecture is actually best for their specific needs. Ask them about their goals.

### Questions to guide them:

- Are they just experimenting locally, or are they building a persistent agent team?
- Do they need an auditable history of agent decisions?
- Will other humans ever interact with this murmuration?
- **Do they use Obsidian or another local Markdown knowledge base?**

### Based on their answers, explain the tradeoffs:

- **Local Governance (`collaboration: local`)**:
  - _Best for_: Operators using Obsidian (or similar PKMs), quick experiments, offline work, strict data privacy, or solo operators.
  - _Pros_: Zero external dependencies, fastest execution, no API limits. **Crucially, if the operator uses Obsidian, local governance means all agent files, issues, and decisions are natively visible and linkable directly inside their vault without context-switching.**
  - _Cons_: Hard to audit over time, lacks native issue tracking for async handoffs.
- **GitHub Governance (`collaboration: github`)**:
  - _Best for_: Persistent agent teams, complex governance (S3, consensus), auditing agent decisions, and multi-human collaboration.
  - _Pros_: System of record is external and highly durable, native support for async threads (Issues/PRs).
  - _Cons_: Requires network access, API tokens, and secure secret management.

### The Privacy Default:

- **CRITICAL:** If they choose GitHub, **always recommend a Private repository by default.**
- Explain that the governance repository holds agent `role.md` files, internal discussions, and potentially sensitive organizational state. Public exposure is a severe security and privacy risk unless they are explicitly building an open-source public project.

_Wait for the operator to make a decision before moving to Phase 2._

## Phase 2: The Setup Steps

If they choose GitHub, walk them through this process one step at a time. Wait for confirmation after each step.

### Step 1. Create the Murmuration Repository

- Create a new repository on GitHub (e.g., `my-org/my-murmuration`). Remind them to make it **Private**.
- Clone the repository locally, or if starting from scratch locally:
  ```bash
  mkdir my-murmuration
  cd my-murmuration
  git init
  ```
- Run `murmuration init .` to scaffold the directory.

### Step 2. Configure harness.yaml

Instruct the operator to open `murmuration/harness.yaml` and configure the collaboration provider:

```yaml
collaboration:
  provider: "github"
  repo: "my-org/my-murmuration" # Replace with their actual repo
```

### Step 3. Give Agents the GitHub MCP Tools

For agents to interact with GitHub issues natively, they need the GitHub MCP server mapped into their `role.md` configuration.
Instruct the operator to edit `murmuration/default-agent/role.md` (or specific agents' `role.md` files) and add the `mcp` block under `tools`:

```yaml
tools:
  mcp:
    - name: github
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: "$GITHUB_TOKEN"
```

### Step 4. Generate a GitHub Token

- **Classic Token (Recommended for simplicity):** Go to GitHub Developer Settings -> Personal access tokens -> Tokens (classic). Generate a new token with the `repo` scope selected.
- **Fine-grained Token:** Ensure it has Read/Write access to Issues, Pull Requests, and Metadata for the specific repository.
- Copy the generated token immediately.

### Step 5. Set the Token in .env

- In the root of their murmuration workspace, create a file named `.env`.
- Add the token:
  ```
  GITHUB_TOKEN=ghp_... (paste the token here)
  ```

### Step 6. Verify and Start

- Confirm that the `.env` file is excluded from source control.
- Run `murmuration start`.
- The agents will now be able to use the `github` tools securely via MCP to read/write to the GitHub issues for governance.
