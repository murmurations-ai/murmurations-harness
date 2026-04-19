# ADR-0026 — Harness directory layout (v0.1 operator repo spec)

- **Status:** Accepted (retroactive — codifies the layout the harness has enforced since v0.1)
- **Date:** 2026-04-19 (retroactively documented; the convention itself predates)
- **Decision-maker(s):** Source
- **Related:** ADR-0016 (role.md frontmatter), ADR-0021 (CollaborationProvider), ADR-0023 (extensions), ADR-0027 (fallback identity), ADR-0029 (agent memory)

## Context

The harness and the `init-skill` both rely on a specific directory
layout for an operator's murmuration repository. The layout has been
consistent since v0.1 and is referenced by name ("v0.1 Harness
layout" / "ADR 0026") in external onboarding material, but no ADR
document was ever written for it. This ADR retroactively codifies
the shape so future changes have something to reference.

## Decision

A murmuration's operator repository uses this layout:

```
<root>/
├── murmuration/
│   ├── soul.md                      # Murmuration soul — purpose, bright lines, values
│   ├── harness.yaml                 # Runtime config (llm, governance, collaboration)
│   └── default-agent/               # Fallback identity templates (ADR-0027)
│       ├── soul.md
│       └── role.md
│
├── agents/
│   └── <agent-id>/                  # One directory per agent
│       ├── soul.md                  # Agent character + bright lines
│       ├── role.md                  # Frontmatter (ADR-0016) + accountabilities
│       ├── memory/                  # Agent persistent memory (ADR-0029)
│       │   ├── <topic>.md
│       │   └── .trash/
│       ├── prompts/                 # Optional — per-agent wake prompt override
│       │   └── wake.md
│       ├── inbox/                   # Optional — inter-agent messages
│       └── notes/                   # Optional — agent-authored private notes
│
├── governance/
│   └── groups/                      # One file per group the murmuration uses
│       └── <group-id>.md            # Group context (purpose, members)
│
├── extensions/                      # Optional — operator-authored extensions (ADR-0023)
│   └── <extension-id>/
│       ├── openclaw.plugin.json
│       └── index.mjs
│
├── skills/                          # Optional — operator-authored skills
│   └── <skill-id>/
│       └── SKILL.md
│
├── .murmuration/                    # Runtime state — daemon writes, operator reads
│   ├── agents/state.json            # Agent lifecycle store
│   ├── runs/<agent-id>/             # Per-wake artifacts + cost index
│   ├── items/                       # Local CollaborationProvider items
│   ├── governance/                  # Governance state (JSONL event log)
│   ├── daemon.pid                   # Current daemon process id
│   └── daemon.sock                  # Unix socket for CLI queries
│
├── .env                             # Secrets (600) — never committed
└── .gitignore                       # Covers .env and .murmuration/
```

### Invariants

1. **`<root>/` is the murmuration root.** Every path the harness
   writes is relative to this directory. No harness code reads or
   writes above the root.
2. **Operator-authored vs daemon-authored.** Anything outside
   `.murmuration/` is operator-authored (identity, governance,
   extensions, skills); anything inside `.murmuration/` is
   daemon-authored runtime state. Agents can write to their own
   `agents/<id>/{memory,notes,inbox}/` subdirectories via the files
   and memory plugins.
3. **`.env` is never committed.** `murmuration init` materializes
   `.gitignore` with `.env` + `.murmuration/` coverage _before_
   writing `.env` (#10, v0.4.4).
4. **Agent directory is the identity boundary.** Each agent's files
   live under `agents/<id>/`; the memory plugin's path safety
   refuses writes outside it. Agents cannot cross-address each
   other's trees.
5. **Naming.** All directory and file names use lowercase with
   dashes. Agent ids, group ids, and memory topics are kebab-case
   slugs. `.md` is the markdown extension.

### Stability

This layout is part of the harness public contract from v0.1
onward. Backward-incompatible changes require a new ADR and a
migration path. Additions (new optional directories under
`agents/<id>/` or `.murmuration/`) do NOT require new ADRs provided
they don't conflict with existing conventions.

## Consequences

- **Positive:** A single canonical reference for the layout. The
  init-skill, the daemon boot code, the dashboard, and the research
  agents all target the same shape.
- **Positive:** Operators can explore a murmuration's state by
  reading the tree — no hidden config locations.
- **Negative:** Pre-v0.2 layouts used `governance/circles/` (S3
  terminology). v0.2 renamed to `governance/groups/` to match the
  harness terminology rule. Operator repos stuck on the old layout
  need a rename step. The init-skill should be audited for any
  remaining `circles/` references; if found, file a follow-up.

## Superseded/related historical artifacts

- `docs/GETTING-STARTED.md` documents a subset of this layout from
  the operator's authoring perspective.
- `packages/init-skill/SKILL.md` generates new murmurations against
  this layout.
