# Lint Design Guide — Write Code That Passes CI On The First Try

**Audience:** Any agent (human or LLM) writing TypeScript in this harness.
**Why this exists:** The harness runs `typescript-eslint` with `strict-type-checked`, `stylistic-type-checked`, and a strict `tsconfig.base.json` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `strictNullChecks`, etc.). Most new features land with the same class of lint failures over and over. This guide captures the recurring patterns and the idiomatic fix for each so future agents can skip the "land it → CI fails → fix it" round-trip.

**If your change fails CI on lint, typecheck, or format, come back here first.** Every error in this guide has been hit multiple times during Phase 2 development.

---

## 0. Before you commit, run:

```sh
pnpm run build && pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm run test
```

All five must be green. The CI workflow runs them in that order and fails the job at the first non-zero exit. **`pnpm run format` will auto-fix formatting; `pnpm run lint --fix` will auto-fix some lint issues.** Run both before committing.

**Never rely on "CI will catch it."** Every failing CI run blocks the branch and wastes a cycle.

---

## 1. `noUncheckedIndexedAccess` — array/map indexing returns `T | undefined`

The base tsconfig enables `noUncheckedIndexedAccess: true`. This means **any array or record lookup returns `T | undefined`, even after a guard**. TypeScript does NOT narrow based on array indexing.

### The trap

```ts
// ❌ BAD — triggers `restrict-template-expressions`
//    (args[idx + 1] is `string | undefined`, even inside the `&&` guard)
if (agentIdx >= 0 && args[agentIdx + 1]) {
  console.log(`agent ${args[agentIdx + 1]}`); // error: string | undefined
}
```

```ts
// ❌ BAD — same bug, different shape
const nextWakes = inactive.map((a) => a.nextWakeCountdown).sort();
if (nextWakes.length > 0) {
  return `soonest: ${nextWakes[0]}`; // error: string | undefined
}
```

### The fix

**Extract the value into a local variable.** Narrowing works on `const` bindings but not on re-reads of array/index expressions.

```ts
// ✅ GOOD
const agentArg = args[agentIdx + 1];
if (agentIdx >= 0 && agentArg) {
  console.log(`agent ${agentArg}`); // agentArg is `string` here
}
```

```ts
// ✅ GOOD — explicit fallback
const soonest = nextWakes[0] ?? "";
return `soonest: ${soonest}`;
```

Do **not** reach for `!` (non-null assertion) — it passes lint as a _warning_ but doesn't teach the next agent why.

---

## 2. Discriminated unions — don't write the last `if`

When you exhaustively check the variants of a discriminated union, **don't write `if (kind === "last-variant")` for the final case.** TypeScript has already narrowed the type to that variant, and `@typescript-eslint/no-unnecessary-condition` will complain that the comparison is always true.

### The trap

```ts
// GithubWriteScopeKind = "issue-comment" | "branch-commit" | "issue" | "label";

// ❌ BAD — the final `if` is always true; lint fails
if (kind === "issue-comment") {
  /* … */ return null;
}
if (kind === "issue") {
  /* … */ return null;
}
if (kind === "branch-commit") {
  /* … */ return null;
}
if (kind === "label") {
  // error: `"label" === "label"` is always true
  /* … */
  return null;
}
return null;
```

### The fix

**Drop the guard on the final variant.** Let the narrowed type carry the story.

```ts
// ✅ GOOD
if (kind === "issue-comment") {
  /* … */ return null;
}
if (kind === "issue") {
  /* … */ return null;
}
if (kind === "branch-commit") {
  /* … */ return null;
}
// kind is "label" here — no guard needed
/* … */
return null;
```

Alternatively, use a `switch` with `never`-exhaustiveness:

```ts
switch (kind) {
  case "issue-comment":
    /* … */ return null;
  case "issue":
    /* … */ return null;
  case "branch-commit":
    /* … */ return null;
  case "label":
    /* … */ return null;
}
```

---

## 3. Optional chaining on non-nullable fields

`@typescript-eslint/no-unnecessary-condition` flags `obj.foo?.bar` when `foo` is non-nullable. A common source of this in our codebase is typing a frontmatter field as `signals: { github_scopes?: … }` (i.e. `signals` is required, only `github_scopes` is optional).

### The trap

```ts
// identity.frontmatter.signals is non-nullable; only github_scopes is optional
const scopes = identity.frontmatter.signals?.github_scopes; // ❌ unnecessary ?.
```

### The fix

```ts
// ✅ GOOD — plain `.` on the non-nullable parent
const scopes = identity.frontmatter.signals.github_scopes;
if (scopes && scopes.length > 0) {
  /* … */
}
```

If you're not sure whether a field is nullable, check the type at the definition site, not at the call site.

---

## 4. Async functions without `await` / async arrow callbacks in tests

`@typescript-eslint/require-await` flags `async` functions that never `await` anything. This trips tests that mock an interface method with an async signature but have a synchronous body.

### The trap

```ts
// ❌ BAD — no await anywhere; require-await fails
plugin.onEventsEmitted = async (batch, store) => {
  for (const event of batch.events) {
    if (event.kind === "tension") store.create(/* … */);
  }
  return [];
};
```

### The fix

**Drop the `async` and return `Promise.resolve(value)` explicitly.** You preserve the `Promise<T>` return type without adding an unused `await`.

```ts
// ✅ GOOD
plugin.onEventsEmitted = (batch, store) => {
  for (const event of batch.events) {
    if (event.kind === "tension") store.create(/* … */);
  }
  return Promise.resolve([]);
};
```

For real production methods that implement an async interface but have no awaitable work, you can also use:

```ts
// eslint-disable-next-line @typescript-eslint/require-await
public async foo(): Promise<void> { /* … */ }
```

…but only when the disable comment is better than dropping `async`.

---

## 5. Empty functions

`@typescript-eslint/no-empty-function` flags `() => {}` and `function () {}` with no body. Most commonly triggered by fire-and-forget patterns like `.catch(() => {})`.

### The trap

```ts
// ❌ BAD
void store.load().catch(() => {});
await new Promise<void>(() => {});
```

### The fix

**Add a comment explaining why the body is intentionally empty.** Prettier will reformat single-line arrows to multi-line, which is fine.

```ts
// ✅ GOOD
void store.load().catch(() => {
  /* best-effort load; missing/invalid state file is tolerated */
});

await new Promise<void>((_resolve) => {
  /* keep process alive until signal */
});
```

---

## 6. `catch` callback parameters must be `unknown`

`@typescript-eslint/use-unknown-in-catch-callback-variable` requires explicit `: unknown` on `.catch((err) => …)` callbacks. TypeScript's default inference here is `any`, which bypasses strict checks.

### The trap

```ts
// ❌ BAD
void doSomething().catch((err) => {
  logger.error("boom", { error: err instanceof Error ? err.message : String(err) });
});
```

### The fix

```ts
// ✅ GOOD — explicit `: unknown`
void doSomething().catch((err: unknown) => {
  logger.error("boom", { error: err instanceof Error ? err.message : String(err) });
});
```

The same rule applies to synchronous `try { … } catch (err) { … }` — TypeScript already infers `unknown` in that case, so you only need to handle it with `err instanceof Error` narrowing.

---

## 7. `Array<T>` vs `T[]`

`@typescript-eslint/array-type` prefers `T[]` over `Array<T>` for simple element types.

### The trap

```ts
// ❌ BAD
const transitions: Array<{ from: string; to: string }> = [];
return { ok: true, value: (body as Array<{ name?: string }>).map(/* … */) };
```

### The fix

```ts
// ✅ GOOD
const transitions: { from: string; to: string }[] = [];
return { ok: true, value: (body as { name?: string }[]).map(/* … */) };
```

Use `Array<T>` only when `T` is a long union or generic that would make `[]` syntax hard to read. Most of the time `T[]` wins.

---

## 8. Unnecessary type assertions / `!` non-null assertions

`@typescript-eslint/no-unnecessary-type-assertion` fires when a cast or `!` doesn't change the inferred type. This usually means you wrote `!` defensively against a value TypeScript already knows is non-null after a guard.

### The trap

```ts
// ❌ BAD — circleId is narrowed to `string` after the guard; `!` is redundant
const circleId = args[idx + 1];
if (!circleId) process.exit(2);
doWork(circleId!); // error: unnecessary assertion (and `!` is a warning)
```

```ts
// ❌ BAD — raw.value.body is already `unknown` from its declared type
const body = raw.value.body as unknown;
```

### The fix

Just **drop the assertion**. If you genuinely need one (e.g. crossing a known-at-runtime boundary TypeScript can't see), prefer a typed helper or a runtime validator over `!`.

```ts
// ✅ GOOD
doWork(circleId);
const body = raw.value.body;
```

Note: `process.exit()` returns `never`, so TypeScript _does_ narrow past it. If your guard uses `process.exit`, you don't need the `!`.

---

## 9. `exactOptionalPropertyTypes` — don't pass `undefined` to optional fields

Our tsconfig enables `exactOptionalPropertyTypes: true`. This means `{ foo?: string }` means "foo may be absent OR a string" — **NOT** "foo may be `undefined`". You can't pass `foo: undefined` to satisfy it.

### The trap

```ts
// ❌ BAD
const context: CircleWakeContext = {
  circleId,
  directiveBody: maybeDirective, // error if maybeDirective is `string | undefined`
};
```

### The fix

**Use a conditional spread.**

```ts
// ✅ GOOD
const context: CircleWakeContext = {
  circleId,
  ...(maybeDirective !== undefined ? { directiveBody: maybeDirective } : {}),
};
```

---

## 10. When you add a new workspace package reference

If you import from `@murmuration/<pkg>` in a package that didn't use it before, you **must** add a TypeScript project reference to its `tsconfig.json`:

```json
{
  "references": [
    { "path": "../core" },
    { "path": "../<pkg>" } // ← add this
  ]
}
```

Without it, `tsc --build` and ESLint's type-checked rules can't resolve the cross-package types. Imports will silently degrade to `any`, and you'll get **dozens of cascading `no-unsafe-assignment`, `no-unsafe-call`, `no-unsafe-member-access`** errors. A single missing reference line has caused 55+ lint errors in one commit.

**Checklist when adding a package dependency:**

1. Add it to `package.json` (`"workspace:*"` for in-repo packages)
2. Run `pnpm install`
3. Add `{ "path": "../<pkg>" }` to the consuming package's `tsconfig.json` `references`
4. Add the source import
5. Run `pnpm run build` (not just the consuming package — the whole workspace, so the referenced package's `dist` is built)
6. Run `pnpm run lint`

---

## 11. File rename checklist

When you rename a source file (e.g. `circle-wake.ts` → `group-wake.ts`) as part of a terminology change, **re-run this guide's patterns against the new file**, because:

- Copying the old file preserves any existing lint issues
- Rename-then-touch commits often reintroduce bugs that were fixed in the old file

We have hit this exact situation at least twice: the circle→group rename copied six lint bugs from `circle-wake.ts` into `group-wake.ts`.

---

## 12. Test files have relaxed rules — but not _no_ rules

The ESLint config relaxes a few rules for `**/*.test.ts`:

- `no-non-null-assertion` → off
- `no-explicit-any` → off
- `no-unsafe-assignment` → off
- `no-unsafe-member-access` → off

Everything else still applies. Most commonly:

- `array-type` (`Array<T>` → `T[]`)
- `require-await` (drop `async` from synchronous mocks)
- `no-unnecessary-condition` (don't write `if (true)` on narrowed values)
- **Typecheck errors** — `tsc --noEmit` runs the full tsconfig and `AgentResult`/etc. type updates still need test fixtures updated

When the `AgentResult` interface grows a new field, **every test fixture that builds an `AgentResult` literal needs the new field too.** `pnpm run build` won't catch this because it uses `tsconfig.build.json` which excludes tests; only `pnpm run typecheck` will.

---

## 13. Non-null assertion warnings are not free

Our config sets `no-non-null-assertion` to `warn` (not `error`). That means `foo!` won't fail CI, but it will clutter the warning tally forever. Prefer:

- Extracting to a narrowed `const` (pattern §1)
- A default via `??`
- A runtime `if (!foo) throw new Error(...)` at a boundary

…over `!`. The warnings are pre-existing technical debt; don't add to them.

---

## 14. Prettier drift

Every time a batch of Phase 2 commits lands, `format:check` accumulates drift. **Always run `pnpm run format` before committing any batch of changes**, even if you think you didn't touch the files Prettier wants to reformat — Prettier often has opinions about files that were edited by other commits.

If you see 10+ files in `format:check` failures, run `pnpm run format` and commit the result as a separate "format pass" commit or combined into the current fix.

---

## TL;DR — the five lint failures that keep repeating

1. **Array index in template literal** → extract to a `const` with a fallback
2. **Final `if` on an exhausted discriminated union** → drop the `if`
3. **Optional chain on a non-nullable parent** → use plain `.`
4. **`async` mock with no `await`** → drop `async`, return `Promise.resolve(x)`
5. **Missing `../pkg` project reference** → the #1 cause of cascading errors when adding a new import

If you hit one of these after reading this guide, please add the specific shape you hit to the relevant section so the next agent sees it.
