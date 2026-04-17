---
version: 1
description: Index of Spirit skill files shipped with the harness baseline
---

# Spirit skills — index

The Spirit loads skill bodies on demand via `load_skill(name)`. This index is always present in the system prompt; bodies are only pulled in when relevant.

| Skill                    | When to load                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `daemon-lifecycle`       | Starting/stopping the daemon, diagnosing why it won't start, the socket protocol, troubleshooting wake runs |
| `agent-anatomy`          | Creating, editing, or debugging agents — `soul.md`, `role.md` frontmatter, signal scopes, write scopes      |
| `governance-models`      | Discussions about governance, plugins, meetings, `governance/groups/*.md`, state graphs, decision records   |
| `when-to-use-governance` | The operator wants to change something and isn't sure whether to act directly or delegate via governance    |

When the operator asks something substantive, check whether one of these skills covers it. If yes, load it before answering. If none applies and you're unsure, say so — don't guess.
