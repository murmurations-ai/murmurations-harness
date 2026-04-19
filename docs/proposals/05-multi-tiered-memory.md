# Architectural Proposal 05: Multi-tiered Memory Architecture

## Context

Currently, the Murmuration Harness relies on the System of Record (e.g., GitHub Issues and Action Items) as its sole form of memory. This functions as "Working Memory" or "Episodic Memory" for the current task. However, as a project grows, agents lose the broader context of why past decisions were made, how similar bugs were solved, or the specific conventions of the codebase that aren't explicitly written in a prompt.

## Proposal

Formalize a multi-tiered memory architecture within the harness. Maintain the current Working Memory (GitHub issues/signals) but introduce a **Semantic/Vector Memory** tier. This tier will automatically index historical decisions, completed tasks, meeting notes, and documentation, allowing agents to query past experiences.

## Specifications

### 1. Memory Tier Definitions

- **Working Memory (Tier 1):** The current `SignalBundle` containing active issues, PRs, and immediate action items. Loaded directly into the system prompt context.
- **Semantic Memory (Tier 2):** A Vector Store holding embeddings of all completed tasks, merged PR descriptions, and past governance decisions.

### 2. The `MemoryStore` Interface

Introduce an interface in `@murmurations-ai/core`:

```typescript
export interface MemoryStore {
  // Indexing new knowledge
  indexDocument(id: string, content: string, metadata: Record<string, unknown>): Promise<void>;

  // Retrieval
  searchSimilar(query: string, limit?: number): Promise<Array<{ content: string; score: number }>>;
}
```

### 3. Automated Knowledge Capture

- When an action item is marked `closed` or `done`, the `Daemon` automatically extracts the summary and solution, generates an embedding via `@murmurations-ai/llm`, and indexes it in the `MemoryStore`.
- When a group meeting concludes, the resulting `content` (meeting minutes) is also indexed.

### 4. Agent Retrieval Tool

- Provide agents with a `search_memory` tool. If an agent is stuck, it can explicitly query the vector store (e.g., `search_memory("How did we fix the auth token bug last month?")`).

## Trade-offs

- **Pros:** Prevents agents from repeating mistakes; allows new agents to "onboard" to a murmuration by searching history; reduces token usage by not cramming all history into the prompt.
- **Cons:** Introduces complexity of managing a vector database (e.g., ChromaDB, SQLite-vss, or pgvector); cost of generating embeddings for all historical data.

## Next Steps

1. Define the `MemoryStore` interface.
2. Implement an adapter for a local, file-based vector store (e.g., SQLite with vector extension or a simple local JSON+cosine similarity approach for the MVP).
3. Update the `ActionTranslator` or `Daemon` to hook into task completion events to trigger indexing.
4. Add the `search_memory` tool to the default agent prompt.
