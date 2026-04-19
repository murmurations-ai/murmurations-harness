# Architectural Proposal 01: Execution Sandboxing (ContainerExecutor)

## Context

Currently, the Murmuration Harness relies on `SubprocessExecutor` and `InProcessExecutor` to run agent tasks. While human oversight (the "Source") sets boundaries, agents executing arbitrary code or shell commands directly on the host machine presents a severe security and stability risk. A hallucinated command like `rm -rf` or a compromised prompt via a GitHub issue could result in catastrophic data loss or system compromise.

## Proposal

Implement a `ContainerExecutor` (utilizing Docker, Podman, or a lightweight VM/microVM like Firecracker) to enforce strict execution sandboxing for all agent tasks. Alternatively or additionally, support a `WasmExecutor` for purely computational tasks compiled to WebAssembly.

## Specifications

### 1. The `ContainerExecutor` Interface

Extend the existing `AgentExecutor` interface to support containerized execution.

```typescript
export interface ContainerExecutorConfig {
  image: string; // e.g., 'murmuration/agent-base:latest'
  memoryLimitMB: number;
  cpuLimit: number;
  networkMode: "none" | "host" | "bridge"; // default to 'none' unless explicitly required
  volumeMounts: ReadonlyArray<{
    hostPath: string;
    containerPath: string;
    readOnly: boolean;
  }>;
}

export class ContainerExecutor implements AgentExecutor {
  // Implements the spawn and execution logic by shelling out to docker/podman
  // or using the Docker Engine API.
}
```

### 2. Ephemeral Workspaces

- Every agent wake creates a completely isolated, ephemeral directory on the host.
- This directory is mounted into the container at a standard location (e.g., `/workspace`).
- Once the execution finishes, artifacts are extracted to a safe location, and the ephemeral directory is purged.

### 3. Network Restrictions

- By default, the container should have NO network access (`--network none`).
- If an agent needs to fetch data or push code, network access must be explicitly granted via configuration or temporarily proxied through the host via a tightly controlled allowlist proxy.

### 4. Tool Execution Proxy

- Tools invoked by the LLM (e.g., `bash`, `read`, `write`) are not executed by the daemon directly.
- Instead, the daemon serializes the tool call, sends it to a lightweight agent-runner inside the container, and awaits the stdout/stderr response.

## Trade-offs

- **Pros:** Massive security improvement; protects the human Source's machine; reproducible environments; prevents dependency collisions between agents.
- **Cons:** Slower startup time for agent wakes (mitigated by keeping hot containers or using microVMs); requires Docker/Podman to be installed on the host machine; more complex logging and debugging.

## Next Steps

1. Create a proof-of-concept `ContainerExecutor` using the Docker CLI.
2. Define a base Docker image (`murmuration-agent-base`) containing essential tools (git, node, python).
3. Update `Daemon` to route tasks to `ContainerExecutor` based on harness configuration.
