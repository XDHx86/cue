<!--
  tier:     permanent
  owner:    claude
  updates:  when the compression model changes (tiers, caps, cadence, adjacency)
  scope:    how this knowledge system stays bounded and drift-free across years
  no-grow:  cap ~120 lines. The rules themselves are bounded; the system they govern is bounded by caps per doc
  belongs:  rewrite-not-append, single source of truth, tier lifecycle, caps, cadence, adjacency, adding/removing docs
  excludes: what each doc *contains* (the docs own that), the retrieval order (retrieval-policy.md)
  migrates: a rule that hardens enough → conventions.md
-->

# compression-policy — rewrite, don't append

The system's reason for existing: it must **never** accumulate thousands of lines of stale
context across years. The lever is caps + rewrite-first + single-source-of-truth, enforced by
the governance header on every file (see [README.md](README.md) ownership table).

## 1. Core principle: rewrite over append
- **Prefer rewriting a section over adding to it.** A summary that can be tightened is
  tightened, not appended to.
- **No append-only logs.** History lives in `git` (commits), not in prose. Don't add
  "changed X on date Y" lines — the commit already records it.
- **`state.md` is rewritten per session**; **`context-summary.md` is rewritten on resume** —
  neither is ever appended.

## 2. Single source of truth per fact
A given fact has **exactly one primary home** (the doc that owns it). Other files may **link**,
never restate. If two docs carry the same fact, delete one and link. Examples:
- architecture vs provider detail → [architecture.md](architecture.md) names the seam;
  [providers.md](providers.md) owns the per-provider specifics.
- human vs AI → [../../docs/architecture.md](../../docs/architecture.md) owns the narrative;
  [architecture.md](architecture.md) owns "what's safe to change".
- [CLAUDE.md](../../CLAUDE.md) restates **nothing** from here; it only routes.

## 3. Tier lifecycle (promotion → pruning)

| Tier | Update | Growth | Compression action |
|---|---|---|---|
| **session** | ephemeral (conversation / `state.md` "Session discoveries") | none | at commit → promote to `memory.md`/`decisions.md`, then **delete** the entry |
| **current** (`state.md`,`implementation-plan.md` status) | per session (rewrite) | bounded | never transcribe diffs → point at `git`; archive completed-phase detail to a status line |
| **compression** (`context-summary.md`) | on resume (rewrite) | bounded | full rewrite; no history |
| **long-term** (`decisions.md`,`memory.md`,`providers.md`,`glossary.md`,`troubleshooting.md`) | when the knowledge changes | slow | merge duplicates; prune obsolete; fold sunk decisions into `memory.md` |
| **permanent** (`architecture.md`,`conventions.md`, policies) | when the code/invariant changes | nearly flat | condense; branch a new owner doc only for a genuinely new domain |

## 4. Volatile state lives in `git`, not prose
`state.md` **points at `git status` / `git diff`**; it never transcribes a working-tree diff.
A transcribed diff is stale the moment it's written — this is the core anti-drift mechanism.

## 5. Per-doc caps (enforce on touch)
From the [README.md](README.md) ownership table. When a doc nears its cap, **compress** (merge
entries, prune obsolete) — do **not** silently raise the cap. Raising a cap is a deliberate
act, recorded in that file's governance header. As a last resort, split a genuinely new domain
into its own owner doc and update the table + [retrieval-policy.md](retrieval-policy.md).

## 6. Cadence / triggers
- **At end-of-feature, before commit** — promote `state.md` "Session discoveries" into
  `memory.md`/`decisions.md`; clear the section; commit doc updates **with** the code change
  (atomic, per [conventions.md](conventions.md)).
- **On resume** — rewrite `context-summary.md` to the current state.
- **On a superseded decision** — mark the old ADR `superseded`, add the new one; once fully
  obsolete (no live references), prune it to a one-line lesson in `memory.md` and delete the
  entry.
- **On a periodic sweep** (whenever current-tier docs are next touched) — prune stale current
  content, dedup long-term docs, retire any term in `glossary.md` that the code dropped.
- **On doc structure change** — update `README.md` ownership table + `retrieval-policy.md` matrix.

## 7. Decisions lifecycle (the exception that keeps history)
Decisions are kept **marked**, not deleted, while superseded — history matters. A fullyobsolete
decision (succeeded by a newer ADR, no live references) is pruned to a one-line lesson in
`memory.md` and removed from `decisions.md`. This is the one place the system deliberately
*retains* history, in compressed form.

## 8. Adding & removing docs
- **Default: don't add.** First ask whether an existing doc should own the new fact.
- Create a new file only for a **genuinely new knowledge domain**. Then: add it to the
  `README.md` ownership table, add a row to the `retrieval-policy.md` matrix, and give it the
  standard governance header.
- When a doc is **removed**, fold its durable facts into the closest owner doc and delete the
  row/table entry in the same change.

## 9. Adjacency — no overlap, clear precedence
- **mem0 MCP** (enabled in `.claude/settings.json`) is an optional *runtime* accelerator, **not**
  the canonical store. This tree is the deterministic, reviewable source of truth; **if mem0
  and a doc disagree, the doc wins and mem0 should be corrected.**
- **Harness memory** (`~/.claude/projects/.../memory/`) — cross-session *user* facts, a
  different domain; no overlap with repo knowledge here.
- **`docs/` + `README.md`** — human-facing; this tree never duplicates their prose.
- **`CLAUDE.md`** — router only; restates nothing.

The governance header on every file is the contract. Caps make growth a **visible, bounded**
property — not open-ended — which is what lets this system scale over years.
