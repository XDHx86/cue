<!--
  tier:     permanent
  owner:    claude
  updates:  when the doc set/structure changes, or a task type is added
  scope:    which .claude/docs/ files to load per task type — the context-loading minimum
  no-grow:  one row per task type; cap ~90 lines. New task rows are rare
  belongs:  the task→docs matrix and the resume on-ramp
  excludes: compression rules (compression-policy.md), the docs' own content
  migrates: a task type that needs many docs usually means a missing owner doc — add that doc, don't expand the row
-->

# retrieval-policy — what to load per task

Goal: minimize context loading. **Load only the docs a task needs; skip the rest.** The
matrix below names the *minimum* set. The constant on-ramp is `CLAUDE.md` (always loaded) →
for a resume, [context-summary.md](context-summary.md) next; otherwise jump to the row.

For **code substance** (what a symbol *is*, who calls it, blast radius), the `codegraph_explore`
tool returns verbatim source + call path — that complements [architecture.md](architecture.md),
which is the *narrative* of the seams. Prefer codegraph for "what is X / who calls X"; prefer
the perma docs for invariants and conventions.

## Resume from a gap
1. [CLAUDE.md](../../CLAUDE.md) (already in context)
2. [context-summary.md](context-summary.md)
3. [state.md](state.md) + [implementation-plan.md](implementation-plan.md)
4. then the task row below.

## Task → docs matrix

| Task | Load (minimum) | Skip unless |
|---|---|---|
| **New feature** | [state.md](state.md), [implementation-plan.md](implementation-plan.md) (does it fit a phase?), [architecture.md](architecture.md), [conventions.md](conventions.md) | [providers.md](providers.md) — if it touches a provider. README + docs/ if user-facing |
| **Bug fix** | [architecture.md](architecture.md), [memory.md](memory.md) (the bug is often a known pitfall), [troubleshooting.md](troubleshooting.md), [state.md](state.md) (in flight/blockers) | [decisions.md](decisions.md) — if the fix must not break an ADR |
| **Refactoring** | [architecture.md](architecture.md), [decisions.md](decisions.md) (don't violate an ADR; supersede if you do), [conventions.md](conventions.md) | [state.md](state.md), [providers.md](providers.md) — if scoped to them |
| **Performance** | [architecture.md](architecture.md) (pipelines), [memory.md](memory.md) (perf foot-guns: ring buffer, per-token spans, click-through), [troubleshooting.md](troubleshooting.md) | [providers.md](providers.md) — if the hotspot is a provider |
| **Release / packaging** | [conventions.md](conventions.md) (`asar:false`, files allowlist, platform branches, model drift), [../../docs/release.md](../../docs/release.md), [state.md](state.md) (don't ship mid-phase) | most others |
| **Documentation** | [README.md](README.md) (this tree's constitution), [compression-policy.md](compression-policy.md), this file, and the target doc's own governance header | the doc it edits |
| **Testing** | [conventions.md](conventions.md) ("tests are pure-Node, electron-independent"), the module + its test file, [memory.md](memory.md) | [architecture.md](architecture.md) — if an integration test |
| **Architecture change** | [architecture.md](architecture.md), [conventions.md](conventions.md), [decisions.md](decisions.md) (likely a new/superseded ADR) | [providers.md](providers.md), [glossary.md](glossary.md) — if they move |
| **Term lookup / "where is X"** | [glossary.md](glossary.md) → the doc it points at | — |

## Rules of thumb
- **Don't load a doc you won't edit or act on.** The matrix is the minimum; adding more is the
  exception, not the default.
- After the work, update only the docs the task **touched** (see
  [compression-policy.md](compression-policy.md) "what to update and when").
- If a task realistically needs **four or five** docs that "don't quite cover it", that's the
  signal a new owner doc is missing — propose one (see [README.md](README.md) "How to update"),
  don't overload the matrix rows.
