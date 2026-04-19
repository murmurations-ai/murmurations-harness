# 0030. Interactive REPL Wakes

Date: 2026-04-19
Status: Draft

## Context

Currently, the Murmuration Harness treats all wakes as asynchronous batch jobs: an agent wakes, reads signals, processes its task, writes a digest, and goes back to sleep. This works well for autonomous worker agents. However, for companion agents (like an Interviewer or a brainstorming partner), users expect a synchronous, interactive streaming chat loop.

If we restrict wakes to only batch jobs, we lose the ability to have real-time dialogue with an agent within the murmuration context, limiting the harness's usefulness for companion-style agents.

## Decision

We will add an `:interact <agent>` command to the REPL. When invoked:

1. The harness will temporarily swap the Spirit's system prompt for the specified agent's `soul.md`/`role.md`.
2. I/O will be bound directly to the user's terminal, enabling an interactive chat loop.
3. The interactive session will continue until the user types `:exit`.
4. Upon `:exit`, the harness will summarize the interactive session, save it as a standard wake digest, and broadcast it to the murmuration.
5. The REPL will then return control to the primary Spirit prompt.

By implementing this after ADR-0029 (Agent Persistent Memory), interactive wakes can natively support `remember()` and `recall()` commands, allowing the companion agent to persist thoughts directly into the user's vault during a live chat.

## Consequences

- **Positive:** Bridges the gap between autonomous workers and interactive companions, supporting real-time use cases within the harness. Wakes from interactive sessions will produce a structured digest, ensuring the rest of the murmuration remains aware of the activity.
- **Negative:** Adds complexity to the REPL and execution engine by introducing synchronous, blocking I/O flows that break the pure async batch model.
- **Negative:** Requires handling context-switching in the terminal UI correctly to avoid confusion about which agent the user is talking to.
