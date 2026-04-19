# Architectural Proposal 06: Model Context Protocol (MCP) Integration

## Context

The README mentions that the harness is "OpenClaw-compatible" for extensions. While having an extension system is crucial for adding new tools, building custom integrations for every API (Slack, Postgres, Figma, Linear) is a massive maintenance burden. The industry is rapidly coalescing around the **Model Context Protocol (MCP)** as the standard way to expose local files, external APIs, and tools to LLM-powered agents.

## Proposal

Adopt the Model Context Protocol (MCP) natively within `@murmurations-ai/core`. Allow the harness to connect to any standard MCP server. This instantly grants Murmuration agents access to a vast, growing ecosystem of pre-built tools without writing any bespoke extension code.

## Specifications

### 1. MCP Client Integration

- Implement an MCP Client within the `Daemon` or `AgentExecutor` initialization.
- The `harness.yaml` config should allow users to define a list of MCP servers (either via stdio or SSE/HTTP).

```yaml
# harness.yaml snippet
mcpServers:
  - name: "postgres"
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
  - name: "slack"
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-slack"]
```

### 2. Tool Translation

- The core must translate the tools exposed by the MCP servers into the format required by the underlying LLM providers in `@murmurations-ai/llm` (e.g., Anthropic tool use format, OpenAI function calling format).

### 3. Resource and Prompt Access

- In addition to Tools, MCP provides Resources (e.g., database schemas) and Prompts. The `SignalAggregator` or the `AgentContext` builder should be able to fetch relevant Resources from the MCP servers to inject into the agent's context window on wake.

### 4. Deprecation Path

- Once MCP is fully supported, evaluate deprecating the bespoke "OpenClaw" extension format in favor of recommending developers build standard MCP servers.

## Trade-offs

- **Pros:** Instant access to hundreds of community-built tools; aligns the harness with the broader AI engineering ecosystem; simplifies the internal extension architecture.
- **Cons:** MCP is a relatively new protocol and still evolving; managing the lifecycles of multiple external MCP server processes adds complexity to the `Daemon`.

## Next Steps

1. Add the official `@modelcontextprotocol/sdk` to `@murmurations-ai/core`.
2. Update the `Daemon` to parse `mcpServers` from the config and spin up the stdio processes.
3. Bridge the MCP `ListToolsRequest` to the LLM client's tool configuration payload.
4. Test with a standard community MCP server (e.g., the local filesystem server or SQLite server).
