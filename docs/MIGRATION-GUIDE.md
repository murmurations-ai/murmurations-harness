# Migration Guide — pre-v0.5 → v0.5.0

v0.5.0 is mostly **additive** — no deprecations, no removed fields, no breaking runtime behavior. Your existing murmuration will keep running. But there are new conveniences worth picking up, and one scenario where you should run `murmuration doctor --fix` to clean up legacy layout.

---

## If your murmuration already uses the ADR-0026 layout

If you ran `murmuration init` on v0.4.x and have `murmuration/`, `agents/<slug>/`, `governance/groups/`, you're already compliant. v0.5.0 is strictly additive for you.

Optional but recommended:

```sh
cd /path/to/your/murmuration
murmuration doctor
```

This will surface anything that would have broken in v0.5.0 (none of it should, but `doctor` is worth running on every murmuration after any upgrade). If it reports `layout.env.mode` or `layout.gitignore.incomplete`, run `murmuration doctor --fix`.

### You can simplify your role.md files

Under Engineering Standard #11 (introduced in v0.5.0), `role.md` frontmatter inherits from directory context and from `murmuration/harness.yaml`. Fields that now default automatically:

- `agent_id` — defaults to the directory slug
- `name` — defaults to the humanized directory name (`research-agent` → `"Research Agent"`)
- `model_tier` — defaults to `"balanced"`
- `soul_file` — defaults to `"soul.md"`
- `llm` — inherits from `murmuration/harness.yaml`'s `llm:` block

You don't have to change your existing role.md files — they'll keep working. But if you want to tidy up, you can remove these fields when they just duplicate the defaults. New agents scaffolded by `murmuration init` on v0.5.0 already ship with the minimum viable frontmatter.

---

## If your murmuration still uses `governance/circles/` (pre-ADR-0026)

ADR-0026 (late v0.4) renamed `governance/circles/` → `governance/groups/`. v0.5.0 `doctor --fix` automates the rename.

### Upgrade path

```sh
cd /path/to/your/murmuration
murmuration doctor
```

If it reports:

```
✗ Layout: governance/circles/ is used — needs renaming to governance/groups/
     Fix: Rename governance/circles/ → governance/groups/ (preserves history if using `git mv`).
     Auto-fix available: `murmuration doctor --fix`
```

Then:

```sh
murmuration doctor --fix
```

This renames `governance/circles/` to `governance/groups/` on disk. Your git history of the old directory is preserved; the next `git status` will show deletes + additions that git detects as renames (at high similarity).

### Also update any live doc references

After the rename, grep your repo for `governance/circles/` in live docs and update them to `governance/groups/`. Historical documents (dated decision records, notes, reports) are audit-trail — leave them alone.

```sh
grep -rl "governance/circles" --exclude-dir=.git --exclude-dir=archive .
```

### Add harness-parseable metadata to each group

v0.5.0 `group-wake` requires each `governance/groups/<id>.md` to have:

```markdown
## Members

- agent-slug-1
- agent-slug-2
- ...

facilitator: agent-slug-1
```

`murmuration doctor` will flag any group missing this. Add the sections inline; they don't disrupt the existing body content.

---

## If your agents have numeric `agent_id: 22` (YAML integer)

Legacy schemas allowed operators to write `agent_id: 22` (a number) in role.md frontmatter. The Zod schema has always wanted a string. v0.5.0 **coerces** numeric `agent_id` to a string automatically — no crash, no migration required.

You can still tidy up by quoting:

```yaml
agent_id: "22"
```

But it's not required. `murmuration doctor` won't flag numeric `agent_id` as an error in v0.5.0.

---

## If you're migrating from Phase 0 (pre-ADR-0026, pre-init) by hand

This is the scenario Emergent Praxis hit on 2026-04-20 — manually assembling a murmuration from flat identity docs. The v0.5.0 init + doctor combination handles most of this now, but you'll still do some manual work.

Honest path:

1. **Scaffold a fresh v0.5.0 murmuration next to your legacy one**:

   ```sh
   murmuration init --example hello /tmp/reference-murm
   ```

   Use the example as a reference for what v0.5.0 expects.

2. **Run `doctor` on your legacy repo** and fix what it flags, either manually or with `--fix`:

   ```sh
   cd /path/to/legacy-murm
   murmuration doctor
   ```

3. **Address each reported issue.** Most will be:
   - Missing `murmuration/harness.yaml` (copy from the reference, then edit)
   - Missing `murmuration/default-agent/{soul,role}.md` (copy from the reference)
   - Missing `.env` / `.gitignore` (init generates; copy or re-run `init` in a tmp dir and lift)
   - `governance/circles/` → `governance/groups/` (doctor --fix)
   - Group files missing `## Members` + `facilitator:` (add inline)

4. **Leave historical flat identity docs in place** as audit trail. If you still have `governance/agents/<legacy>.md` files, consider moving them to `archive/legacy-governance/` so they don't confuse future operators. They're not on the runtime path; `agents/<slug>/role.md` is.

5. **Validate end-to-end** with a group-wake once doctor is clean:
   ```sh
   murmuration convene --group <your-group> --directive "test"
   ```

The Emergent Praxis migration is the reference case study for this path. See [`xeeban/emergent-praxis` PRs #463–#465](https://github.com/xeeban/emergent-praxis/pulls?q=is%3Apr+adr-0026) for what it looked like in practice (with all the missteps we fixed in v0.5.0 by making them impossible to reproduce).

---

## Breaking changes: none

v0.5.0 deliberately avoids breaking anything. Every v0.5.0 change is either additive (new command, new field defaults, new example) or stricter-by-default error reporting (real messages instead of swallowed `UNKNOWN` codes).

If you hit an unexpected behavior change, open an issue — it's a bug we'd want to fix before v0.5.1.

---

## CLI command additions

New in v0.5.0:

- `murmuration init --example hello [dir]` — scaffold the bundled hello-circle example
- `murmuration doctor [--live] [--fix] [--json]` — preflight diagnosis + auto-remediation

---

## Summary

For almost every operator: `murmuration doctor --fix` is the migration. It catches the handful of real cleanups (circles→groups rename, chmod 600 on .env, missing .gitignore entries) and leaves your content alone.
