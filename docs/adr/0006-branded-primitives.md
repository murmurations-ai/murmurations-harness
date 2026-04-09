# ADR-0006 — Branded primitive types for identifiers

- **Status:** Accepted
- **Date:** 2026-04-09 (retroactive; design from A1 commit `428d8f2`)
- **Decision-maker(s):** TypeScript / Runtime Agent #24
- **Consulted:** Architecture Agent #23

## Context

The harness passes many string identifiers across its public API: agent ids (`"08-editorial"`), circle ids (`"content"`), wake ids (a UUID per wake), governance round ids, event ids, etc. They are all strings, but they are not interchangeable — passing an `agentId` where a `circleId` is expected is a bug.

In plain TypeScript, `string` is `string` — the compiler cannot distinguish them. The common fix is to use branded types (sometimes called "nominal types" or "opaque types") to prevent cross-wiring at the type level without runtime overhead.

Two implementation approaches:

1. **String intersection with a phantom brand field:**
   ```typescript
   type AgentId = string & { __brand: "agent-id" };
   ```
2. **Wrapped object with a kind discriminant:**
   ```typescript
   interface AgentId {
     readonly kind: "agent-id";
     readonly value: string;
   }
   ```

## Decision

**Use the wrapped-object approach:**

```typescript
export interface AgentId {
  readonly kind: "agent-id";
  readonly value: string;
}
export const makeAgentId = (value: string): AgentId => ({ kind: "agent-id", value });
```

Applied to: `AgentId`, `CircleId`, `WakeId`, and any other identifier that represents a distinct category of entity.

Also applied to the `AgentSpawnHandle` — it is branded with a per-executor-instance `__executor` id so handles cannot be used across different executor instances.

## Consequences

**Makes easier:**

- Type-level safety: passing `AgentId` where `CircleId` is expected is a compile error, not a runtime surprise
- Runtime inspectability: `handle.kind === "agent-spawn-handle"` is a real check, not just a phantom type — useful in JSON serialization, logging, debugging
- Constructors enforce shape: `makeAgentId("foo")` is the only way to get an `AgentId`, so the invariant is enforced at the boundary
- Pattern matching: discriminated unions over `kind` are straightforward

**Makes harder:**

- Slightly more verbose than string intersections — `ctx.agentId.value` vs `ctx.agentId`
- Serialization needs care — JSON.stringify-ing a branded object and then reading it back loses the type discrimination unless explicitly rehydrated. We addressed this in `subprocess.ts` by serializing only `.value` fields for env var transport.
- Runtime cost (marginal): every identifier is an object allocation instead of a string intern

**Reversibility cost:** Medium-high. Switching to string intersection would require touching every call site (`.value` references would disappear). Doable but tedious.

## Alternatives considered

- **Phantom brand on string intersection** (`string & { __brand: ... }`) — rejected because it has no runtime presence. You cannot log `typeof` the brand, you cannot guard on it at runtime, and serialization round-trips lose the brand implicitly anyway. The wrapped-object approach gives the same type safety plus runtime observability.
- **No branding, just naming conventions** — rejected because naming conventions do not prevent mix-ups at the type level. Cross-wiring is the exact class of bug we want the compiler to catch.
- **Zod or io-ts runtime schemas** — rejected for this purpose because we do not need runtime parsing for internal identifiers; they are minted by the harness and never parsed from untrusted sources. Runtime schemas are overkill here. We may use Zod for frontmatter parsing (untrusted input) in Phase 1B.

## Related

- A1 implementation: `packages/core/src/execution/index.ts` defines `AgentId`, `CircleId`, `WakeId`, and `AgentSpawnHandle` with the wrapped-object brand
- `subprocess.ts` uses a `Symbol`-keyed hidden property on `AgentSpawnHandle` to track internal bookkeeping without exposing it on the public type
