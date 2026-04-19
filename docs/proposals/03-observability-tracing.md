# Architectural Proposal 03: Deep Observability and Tracing

## Context

Debugging a multi-agent system is inherently difficult. When a murmuration gets stuck in an infinite loop, hallucinates a strange response, or makes a flawed governance decision, identifying the root cause is challenging. While the TUI dashboard provides a point-in-time view, understanding the historical flow requires distributed tracing.

## Proposal

Instrument the entire `@murmurations-ai/core` and related packages with **OpenTelemetry (OTel)**. Every group meeting, agent wake, LLM prompt, and tool execution should generate linked distributed traces, allowing export to standard observability backends (e.g., Datadog, Honeycomb, LangSmith).

## Specifications

### 1. Span Hierarchy

Define a standardized trace hierarchy:

- **Trace:** An entire "Wake Cycle" or "Group Meeting".
- **Parent Spans:** `Daemon.handleWake`, `GroupMeeting.facilitate`.
- **Child Spans:** `SignalAggregator.fetch`, `AgentExecutor.spawn`, `LLMClient.generateText`, `Tool.execute`.

### 2. Semantic Conventions

Adhere to standard OpenTelemetry semantic conventions and define Murmuration-specific attributes:

- `murmuration.agent.id`: The ID of the agent executing.
- `murmuration.group.id`: The ID of the group meeting.
- `murmuration.governance.state`: The current state of the governance machine.
- `llm.prompt.tokens`: Input token count.
- `llm.completion.tokens`: Output token count.

### 3. Log Exporter Integration

- Modify the existing `logger` utility to attach the active `trace_id` and `span_id` to all structured logs.
- Ensure sensitive data (like `SecretValue`) remains scrubbed before being attached to span attributes, reusing the existing `scrubLogRecord()` logic.

### 4. Visualization & Tooling

- Provide a default OTLP (OpenTelemetry Protocol) exporter configuration targeting a local Jaeger or Prometheus instance for local development.
- Provide easy bridges to LLM-specific observability platforms like Braintrust or Langfuse for prompt/eval tracking.

## Trade-offs

- **Pros:** Unprecedented visibility into agent decision-making; easier debugging of cascading failures; capability to run performance and cost analytics over time.
- **Cons:** Adds dependency bloat (OTel SDKs can be heavy); potential performance overhead if tracing everything; requires discipline to instrument new modules correctly.

## Next Steps

1. Install `@opentelemetry/api` and `@opentelemetry/sdk-node` into `@murmurations-ai/core`.
2. Wrap the `Daemon.#handleWake` and `runGroupWake()` in root spans.
3. Propagate context down to the `@murmurations-ai/llm` client to capture prompt generation spans.
4. Document how to run a local Jaeger instance alongside the daemon.
