# Agentic Engineering and Harness Design Resource List

Date: 2026-05-07

This is a curated study list for the 2026 state of agentic engineering: agent harnesses, tool interfaces, durable execution, protocol interoperability, evaluation, observability, and agentic software engineering benchmarks.

The short version: state-of-the-art agentic engineering is less about prompting and more about the harness around the model. The important surfaces are tool design, state, permissions, sandboxing, memory, evals, tracing, durable execution, human review, rollback paths, and protocol boundaries.

## Recommended Study Path

1. Start with Anthropic's conceptual model for workflows, agents, and tools.
2. Study the major harness/framework families: OpenAI Agents SDK, Claude Agent SDK, LangGraph, AutoGen/Microsoft Agent Framework, Pydantic AI, CrewAI, and Google ADK.
3. Learn the interoperability layer: MCP for tools/data, A2A for agent-to-agent work, AG-UI for agent-user interaction, and OpenTelemetry for traces/metrics.
4. Study evaluation practice through Inspect AI, Pydantic Evals, Phoenix, Braintrust, Terminal-Bench, SWE-agent, SWE-rebench, WebArena, WorkArena, and Magentic-One.
5. Build small harnesses and repeatedly evaluate them against realistic tasks.

## Foundations

1. [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)
   - Best conceptual starting point. Distinguishes workflows from agents and gives practical patterns such as routing, prompt chaining, evaluator-optimizer, orchestrator-worker, and autonomous tool use.

2. [Anthropic: Writing Effective Tools for Agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
   - Essential for harness design. The main lesson is that agent performance depends heavily on tool affordances, descriptions, schemas, error feedback, and evaluation loops.

3. [Claude: Building Agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)
   - Explains the "give the agent a computer" model behind Claude Code/Claude Agent SDK: filesystem, shell, context management, subagents, verification loops, and practical tool design.

4. [Claude Agent SDK Overview](https://docs.claude.com/en/docs/agent-sdk/overview)
   - Current product docs for the SDK. Useful for studying subagents, skills, MCP, permissions, context management, and production agent loops.

5. [Anthropic Video: Building More Effective AI Agents](https://www.youtube.com/watch?v=uhJJgc-0iTQ)
   - Useful visual discussion of current agent design patterns, subagents, skills, MCP, tool design, and common failure modes. The URL was validated via indexed references because direct video fetches can be limited.

## Frameworks and Harnesses

6. [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents)
   - Study for handoffs, tools, tracing, streaming, and lightweight orchestration. Good if you want production-oriented primitives without a large orchestration framework.

7. [OpenAI Agents SDK Guardrails](https://openai.github.io/openai-agents-python/guardrails/)
   - Important for input, output, and tool guardrails. Especially relevant for agents with write permissions, filesystem access, publishing authority, or payment-adjacent operations.

8. [LangGraph Durable Execution](https://docs.langchain.com/oss/python/langgraph/durable-execution)
   - Study for stateful, resumable workflows with checkpoints, interrupts, human-in-the-loop review, and long-running execution.

9. [CrewAI Docs](https://docs.crewai.com/)
   - Best for role-based multi-agent teams and rapid orchestration. Relevant to circle/role-based agent teams.

10. [CrewAI Flows](https://crewai.com/crewai-flows)
    - Useful for mixing deterministic workflow steps with agentic delegation. Good reference for avoiding unnecessary autonomy where a simple workflow is better.

11. [AutoGen Docs](https://microsoft.github.io/autogen/stable/index.html)
    - Major research-to-production lineage for multi-agent conversations, group chat, coding agents, MCP workbenches, Docker code execution, and distributed runtimes.

12. [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/overview/)
    - Microsoft's successor direction combining AutoGen and Semantic Kernel ideas. Study its agent-vs-workflow distinction, type safety, telemetry, persistence, and enterprise hosting model.

13. [Pydantic AI Agents](https://pydantic.dev/docs/ai/core-concepts/agent/)
    - Strong for typed Python agent engineering: structured outputs, dependency injection, toolsets, and production-grade validation.

14. [Pydantic AI Durable Execution](https://pydantic.dev/docs/ai/integrations/durable_execution/overview/)
    - Connects agent runs to Temporal, DBOS, Prefect, and Restate. Useful for long-running and human-in-the-loop systems.

15. [Hugging Face smolagents](https://huggingface.co/docs/smolagents/en/index)
    - Minimalist counterweight to larger frameworks. Good for learning code agents, telemetry, secure execution, and small abstractions.

16. [Google Agent Development Kit](https://adk.dev/)
    - Google's production-agent stack: multi-language SDKs, graph workflows, evaluation, debugging, deployment, and A2A integration.

## Protocols and Interoperability

17. [Model Context Protocol Architecture](https://modelcontextprotocol.io/docs/learn/architecture)
    - Core protocol reading. MCP standardizes how agents connect to tools, resources, prompts, and external systems.

18. [Agent2Agent Protocol Specification](https://google-a2a.github.io/A2A/specification/)
    - Study for agent-to-agent interoperability: discovery, task lifecycle, collaboration, and exchanging artifacts without exposing internal memory or tools.

19. [AG-UI Protocol](https://docs.ag-ui.com/introduction)
    - Agent-user interaction protocol for streaming events, shared state, interrupts, frontend tool calls, and UI integration.

20. [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
    - Emerging observability standard for model calls, tool spans, token metrics, latency, and trace structure.

## Evaluation and Observability

21. [Inspect AI](https://inspect.aisi.org.uk/)
    - Open-source evaluation framework from the UK AI Security Institute. Supports coding, agentic tasks, tool calling, sandboxing, browsing, and reusable scorers.

22. [AISI: Inspect Evals](https://www.aisi.gov.uk/blog/inspect-evals)
    - Library of reusable evaluations. Useful for learning how serious eval suites are packaged, shared, and run across models.

23. [Pydantic Evals](https://pydantic.dev/docs/ai/evals/evals/)
    - Code-first eval framework for agents. Especially useful for span-based evaluation, where correctness depends on how an agent used tools, not just the final answer.

24. [Arize Phoenix](https://arize.com/docs/phoenix)
    - Open-source tracing, prompt management, datasets, experiments, and evals. Practical observability stack for agent runs.

25. [Braintrust Evals](https://www.braintrust.dev/docs/evaluate)
    - Strong resource for systematic AI evaluation: datasets, scorers, experiments, regression detection, and CI-style evals.

26. [LangSmith Observability Concepts](https://docs.langchain.com/langsmith/observability-concepts)
    - Useful even outside LangChain. Explains traces, runs, threads, feedback, metadata, and how to inspect agent behavior.

## Agentic Software Engineering Benchmarks

27. [SWE-agent Paper](https://arxiv.org/abs/2405.15793)
    - Foundational paper for Agent-Computer Interfaces. The key insight is that agents need interfaces designed for them, not just raw terminal access.

28. [SWE-agent ACI Docs](https://swe-agent.com/1.0/background/aci/)
    - Practical explanation of Agent-Computer Interface design: file viewers, edit commands, linting, feedback, and tool constraints.

29. [OpenAI: Why SWE-bench Verified No Longer Measures Frontier Coding Capabilities](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
    - Important 2026 benchmark-literacy piece. Explains contamination and why static public coding benchmarks become stale.

30. [SWE-rebench](https://arxiv.org/abs/2505.20411)
    - Fresh, decontaminated, automatically collected software-engineering tasks. Useful for thinking about continuous benchmark generation.

31. [Microsoft Research: Saving SWE-Bench](https://www.microsoft.com/en-us/research/publication/saving-swe-bench-a-benchmark-mutation-approach-for-realistic-agent-evaluation/)
    - Shows how GitHub-issue style benchmarks can overestimate real-world coding-assistant performance. Useful for designing realistic user-query evals.

32. [Terminal-Bench Paper](https://arxiv.org/abs/2601.11868)
    - Terminal-native benchmark for setup, shell use, debugging, environment discovery, and multi-step execution.

33. [Terminal-Bench](https://www.tbench.ai/)
    - Official benchmark site. Use alongside the paper when tracking current benchmark tasks and results.

34. [Warp: How We Scored #1 on Terminal-Bench](https://www.warp.dev/blog/terminal-bench)
    - Practical engineering writeup on improving terminal-agent performance. Good for harness design, planning, tool loops, and execution strategy.

## Generalist, Web, and Knowledge-Work Agents

35. [Magentic-One](https://www.microsoft.com/en-us/research/publication/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)
    - Major multi-agent reference architecture: orchestrator, web surfer, file surfer, coder, and terminal agent. Study the architecture and failure analysis.

36. [AutoGen Magentic-One Docs](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html)
    - Practical implementation view of Magentic-One inside AutoGen AgentChat.

37. [WebArena](https://webarena.dev/og/)
    - Canonical benchmark for browser agents on realistic self-hosted websites. Useful for understanding end-state correctness and realistic web task evaluation.

38. [WorkArena / BrowserGym](https://arxiv.org/abs/2403.07718)
    - Focuses on enterprise knowledge-work tasks in browser-based software. Highly relevant to operational and administrative agents.

39. [GAIA Benchmark](https://arxiv.org/abs/2311.12983)
    - General assistant benchmark covering reasoning, web browsing, multimodality, tool use, and multi-step problem solving.

## 2026 Emphasis

The older 2023-2024 papers remain foundational, but the 2026 center of gravity is:

- Durable and inspectable harnesses, not one-shot prompts.
- Tool design as a first-class engineering discipline.
- Agent-computer interfaces and sandboxed execution.
- Explicit protocol boundaries: MCP, A2A, AG-UI.
- Evals tied to traces and tool behavior, not just final outputs.
- Decontaminated and realistic benchmarks such as SWE-rebench, Terminal-Bench, and benchmark mutation approaches.
- Human-in-the-loop gates for high-impact actions.

## Link Validation Notes

A fast validation pass found the links above to be real and appropriate, with these adjustments applied:

- Updated redirected links to canonical destinations where possible.
- Replaced non-primary Hugging Face paper pages with arXiv links for SWE-agent, SWE-rebench, WorkArena, and GAIA.
- Replaced the ResearchGate Terminal-Bench mirror with the arXiv paper and official Terminal-Bench site.
- Updated smolagents from a pinned old version path to the current unpinned documentation path.
- Kept the YouTube video with a note that direct fetches can be limited, but indexed references confirm the video.
