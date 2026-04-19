# Architectural Proposal 04: Durable Execution State

## Context

The `Daemon` currently relies on an in-memory `TimerScheduler` and local `AgentStateStore` files to manage execution state. If the daemon process crashes or the host machine restarts during a long-running agent task (e.g., compiling a large codebase or scraping multiple web pages), the progress is lost. The agent must start over on the next wake, which wastes compute, tokens, and time.

## Proposal

Adopt a **Durable Execution** paradigm for the `AgentExecutor`. Using concepts similar to Temporal.io or AWS Step Functions, ensure that execution state (including intermediate LLM steps and tool outputs) is durably checkpointed so that an agent can resume exactly where it left off after an interruption.

## Specifications

### 1. The Execution Log

Instead of just executing commands, the `AgentExecutor` should maintain an append-only "Execution History" log for each wake.

- Every input (prompt), output (completion), and tool result is written to this log _before_ proceeding to the next step.
- If the process crashes, the `Daemon` reads the log upon restart and "replays" the deterministic steps to reconstruct the agent's memory state without re-calling the LLM or re-running completed tools.

### 2. Checkpointing

- Introduce a `yield` or `checkpoint` primitive in the `Executor` interface.
- Long-running loops inside the agent should periodically checkpoint their state.

### 3. Idempotent Tool Execution

- Tools must be categorized. "Safe" tools (like `read_file`) can be re-run if needed. "Mutating" tools (like `github_commit` or `send_email`) must check the execution log to ensure they are not executed twice during a replay scenario.

### 4. Storage Backend

- Use a lightweight embedded database (like SQLite) or a structured JSONL append-only file per task to store the Execution History. The single-writer principle defined in the architecture standards must apply here.

## Trade-offs

- **Pros:** Massive reliability boost; eliminates wasted tokens on aborted runs; essential for long-running autonomous tasks; gracefully handles rate-limits by sleeping and resuming.
- **Cons:** Major architectural shift for the execution engine; requires rigorous handling of non-deterministic tool outputs; higher disk I/O due to constant checkpointing.

## Next Steps

1. Design the schema for the Execution History log.
2. Implement an append-only JSONL logger for the `AgentExecutor`.
3. Create a prototype where an agent process is killed halfway through a task, and the Daemon successfully resumes it from the exact LLM turn by reading the log.
