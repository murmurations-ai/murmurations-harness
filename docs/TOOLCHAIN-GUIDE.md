# Murmuration Toolchain Guide

The Murmuration Harness relies heavily on the **Model Context Protocol (MCP)** to give agents their capabilities. Before you run `murmuration init` and start an agent swarm, you should set up the necessary tools on your host machine.

This guide walks you through installing and configuring the recommended baseline tools for a production murmuration.

---

## 1. Node.js & `npx` (Required)

Many standard MCP servers (like the official GitHub integration) are distributed as npm packages and run via `npx`.

**Setup:**
Ensure you have Node.js (v20+) installed:

```bash
node --version
npx --version
```

If you don't have Node installed, use [nvm](https://github.com/nvm-sh/nvm) or your system's package manager.

---

## 2. GitHub MCP Server (The Nervous System)

GitHub Issues act as the primary coordination and async messaging layer for agents. You will need the GitHub MCP server so agents can read and write to issues.

**Installation:**
No installation is required if you have `npx`. The harness will invoke it dynamically:

```yaml
# Inside an agent's role.md:
tools:
  mcp:
    - name: github
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
```

**Authentication:**
You must provide a GitHub Personal Access Token (Classic with `repo` scope, or Fine-Grained with read/write access to your murmuration repository).
Add it to the `.env` file at the root of your murmuration:

```bash
GITHUB_TOKEN=ghp_...
```

---

## 3. Token Optimization: The jMunch Suite (Highly Recommended)

Standard MCP servers return massive, raw JSON payloads (e.g., fetching a GitHub issue might cost 50,000 tokens). This quickly exhausts context windows, slows down reasoning, and blows out budgets.

To solve this, we strongly recommend using the **jMunch** suite of tools, which implement the [jMRI specification](https://github.com/jgravelle/mcp-retrieval-spec) to compress massive payloads by up to 90%.

### A. `jmunch-mcp` (The Transparent Proxy)

This tool wraps fat API servers (like GitHub) and compresses their JSON output into tiny, queryable "handles" for the agents.

**Installation (via `uv` or `pip`):**

```bash
# Recommended: using uv
uv tool install jmunch-mcp

# Or via pip and a virtual environment:
python3 -m venv ~/.local/share/jmunch
source ~/.local/share/jmunch/bin/activate
pip install jmunch-mcp
```

**Configuration:**
Create a `.murmuration/jmunch-github.toml` file in your workspace to tell jMunch to wrap the GitHub MCP server:

```toml
[upstream]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]

[upstream.env]
GITHUB_PERSONAL_ACCESS_TOKEN = "$GITHUB_TOKEN"

threshold_tokens = 2000
log_level = "INFO"
```

**Agent `role.md` Setup:**

```yaml
tools:
  mcp:
    - name: github
      command: jmunch-mcp
      args: ["--config", ".murmuration/jmunch-github.toml"]
```

### B. `jdocmunch-mcp` (For Local Markdown/Obsidian)

If your murmuration manages a local knowledge base, meeting transcripts, or an Obsidian vault, `jdocmunch-mcp` parses the Markdown headers (`# H1`, `## H2`) and allows agents to retrieve exact sections instead of reading 100,000-word files blindly.

**Installation:**

```bash
uv tool install jdocmunch-mcp
```

**Agent `role.md` Setup:**

```yaml
tools:
  mcp:
    - name: jdocmunch
      command: jdocmunch-mcp
      args: []
```

---

## 4. Validating Your Setup

Once you've installed your tools and created your `.env` file, you can test your environment.
Run the Murmuration initialization:

```bash
murmuration init my-swarm
cd my-swarm
```

You can explicitly test an agent's access to its tools by waking it interactively (or manually firing a directive):

```bash
murmuration directive "Test your GitHub connection and summarize issue #1" --agent my-agent
murmuration start --agent my-agent --now --once
```

If you experience "Authentication Failed" or `npx` timeouts, ensure your `.env` file is properly loaded and your `max_wall_clock_ms` in `role.md` is high enough (e.g., `120000` ms) to allow for tool boot times.
