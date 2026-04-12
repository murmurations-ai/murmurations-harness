# GitHub Label Taxonomy

Label conventions for the Murmuration Harness. The harness uses a
small set of **structural labels** that have built-in semantics.
Everything else is operator-defined — each murmuration adds labels
for its own circles, agents, governance states, and pipeline stages.

**Operators extend, the harness doesn't prescribe.**

## Source Directives

| Label | Use |
|---|---|
| `source-directive` | Issue is a Source directive (question/instruction/decision) |
| `scope:all` | Directive targets all agents |
| `scope:circle:<id>` | Directive targets a specific circle |
| `scope:agent:<id>` | Directive targets a specific agent |

## Governance

| Label | Use |
|---|---|
| `governance:tension` | A tension filed by an agent or Source |
| `governance:proposal` | A formal proposal awaiting consent |
| `governance:decision` | A ratified governance decision |

## Governance State (state machine via label swaps)

The `state:*` labels map to the governance plugin's state graph.
These are **operator-defined** based on the governance model in use.

**Self-Organizing (S3) example:**
`state:open`, `state:deliberating`, `state:consent-round`, `state:resolved`, `state:withdrawn`, `state:ratified`, `state:rejected`

**Chain of Command example:**
`state:drafted`, `state:submitted`, `state:approved`, `state:executing`, `state:completed`, `state:rejected`

**Parliamentary example:**
`state:motion`, `state:seconded`, `state:debate`, `state:vote`, `state:passed`, `state:failed`, `state:tabled`

The governance plugin's `stateGraphs()` method declares the valid states. The harness creates `state:*` labels from those declarations.

## Circles / Domains

| Pattern | Use |
|---|---|
| `circle:<id>` | Associates an issue with a circle/domain |

_Operator-defined. Each murmuration creates labels for its own circles. Examples: `circle:content`, `circle:engineering`, `circle:operations`._

## Meetings

| Label | Use |
|---|---|
| `circle-meeting` | Operational circle meeting minutes |
| `governance-meeting` | Governance circle meeting minutes |

## Agents (for targeted items)

| Label | Agent |
|---|---|
| `agent:<id>` | Targets or was filed by a specific agent (e.g. `agent:01-research`) |

## Pipeline / Workflow (operator-defined)

Each murmuration defines its own workflow labels. Examples:

- Content pipeline: `type:content-idea`, `stage:research`, `stage:editorial`
- Software pipeline: `type:feature`, `type:bug`, `stage:review`, `stage:deploy`
- Research pipeline: `type:hypothesis`, `stage:experiment`, `stage:analysis`

## Usage Rules

1. **State labels are exclusive** — only one `state:*` label per issue at a time. Transitions = remove old + add new.
2. **Circle labels are additive** — an issue can belong to multiple circles if it spans them.
3. **Scope labels are exclusive** — a directive has exactly one scope.
4. **Agent labels are additive** — a governance item can involve multiple agents.
5. **Operators extend** — add labels for your murmuration's specific needs. The harness reads labels generically; only the ones above have built-in semantics.
