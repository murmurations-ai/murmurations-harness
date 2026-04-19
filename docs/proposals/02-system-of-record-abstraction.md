# Architectural Proposal 02: Abstraction of System of Record

## Context

The Murmuration Harness currently hardcodes GitHub as the System of Record. Action items are translated into GitHub issues, labels are used for assignment (`assigned:<agentId>`), and the `@murmurations-ai/github` package is deeply intertwined with the core logic. While GitHub is an excellent default, this tight coupling limits the framework's enterprise viability where tools like Linear, Jira, GitLab, or Notion are the centers of gravity.

## Proposal

Introduce a generic `CollaborationProvider` (Adapter/Port) interface in `@murmurations-ai/core`. Move all GitHub-specific logic into an implementation of this interface (e.g., `GitHubCollaborationProvider`).

## Specifications

### 1. The `CollaborationProvider` Interface

Define a standardized set of asynchronous capabilities that any System of Record must provide.

```typescript
// Core abstractions
export type TaskId = string & { readonly __brand: unique symbol };
export type AgentId = string & { readonly __brand: unique symbol };

export interface TaskItem {
  id: TaskId;
  title: string;
  description: string;
  status: "open" | "in_progress" | "done" | "blocked";
  assignedTo?: AgentId;
  metadata: Record<string, unknown>; // For provider-specific data (e.g., GH issue #)
}

export interface CollaborationProvider {
  // Task Management
  createTask(task: Omit<TaskItem, "id">): Promise<TaskItem>;
  updateTask(id: TaskId, updates: Partial<TaskItem>): Promise<TaskItem>;
  getAssignedTasks(agentId: AgentId): Promise<ReadonlyArray<TaskItem>>;

  // Signaling / Communication
  addComment(id: TaskId, content: string): Promise<void>;

  // Governance / Meeting outputs
  publishMeetingNotes(groupId: string, content: string): Promise<string>;
}
```

### 2. Signal Aggregator Decoupling

The `SignalAggregator` must be updated to consume arrays of `CollaborationProvider`. It will query all configured providers for pending signals/tasks and normalize them into a standard `SignalBundle` for the agents.

### 3. Action Translation

When an agent or group meeting outputs JSON actions, the `ActionTranslator` will route the action to the appropriate provider based on the context or explicit configuration (e.g., "Create a Jira ticket").

## Trade-offs

- **Pros:** Enables enterprise adoption; avoids vendor lock-in; allows "polyglot" murmuration operations (e.g., engineering tasks in Linear, HR tasks in Notion); aligns with Clean Architecture principles.
- **Cons:** The lowest common denominator problem (the interface might omit powerful provider-specific features); requires writing mapping layers for every new integration; refactoring the current GitHub-centric code will touch many files.

## Next Steps

1. Extract the `CollaborationProvider` interface in `@murmurations-ai/core`.
2. Wrap the existing `@murmurations-ai/github` functionality into a `GitHubCollaborationProvider`.
3. Swap direct GitHub client calls in the `Daemon` and `SignalAggregator` with calls to the interface.
4. Implement a lightweight `LocalDiskCollaborationProvider` for testing without network calls.
