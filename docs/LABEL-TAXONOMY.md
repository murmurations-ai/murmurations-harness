# GitHub Label Taxonomy

Canonical label set for the Murmuration Harness. All collaborative
state tracked via GitHub issues uses these labels for categorization,
state tracking, and scoping.

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

| Label | State |
|---|---|
| `state:open` | Newly created, not yet deliberated |
| `state:deliberating` | Under active discussion |
| `state:consent-round` | Formal consent round in progress |
| `state:resolved` | Tension resolved (terminal) |
| `state:withdrawn` | Withdrawn by filer (terminal) |
| `state:ratified` | Proposal ratified by consent (terminal) |
| `state:rejected` | Proposal rejected (terminal) |

## Circles

| Label | Circle |
|---|---|
| `circle:content` | Content circle |
| `circle:intelligence` | Intelligence circle |
| `circle:publishing` | Publishing circle |
| `circle:community` | Community circle |
| `circle:sales-marketing` | Sales & Marketing circle |
| `circle:design-visual` | Design & Visual circle |
| `circle:finance-legal` | Finance & Legal circle |
| `circle:quality` | Quality circle |

_Operators add labels for their own circles._

## Meetings

| Label | Use |
|---|---|
| `circle-meeting` | Operational circle meeting minutes |
| `governance-meeting` | Governance circle meeting minutes |

## Agents (for targeted items)

| Label | Agent |
|---|---|
| `agent:<id>` | Targets or was filed by a specific agent (e.g. `agent:01-research`) |

## Content Pipeline (operator-defined)

These are examples — each murmuration defines its own pipeline labels:

| Label | Use |
|---|---|
| `type:content-idea` | A content idea for validation |
| `type:research-digest` | A research digest issue |
| `stage:research` | Content in the research stage |
| `stage:editorial-planning` | Content being planned for editorial |

## Usage Rules

1. **State labels are exclusive** — only one `state:*` label per issue at a time. Transitions = remove old + add new.
2. **Circle labels are additive** — an issue can belong to multiple circles if it spans them.
3. **Scope labels are exclusive** — a directive has exactly one scope.
4. **Agent labels are additive** — a governance item can involve multiple agents.
5. **Operators extend** — add labels for your murmuration's specific needs. The harness reads labels generically; only the ones above have built-in semantics.
