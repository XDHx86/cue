<!--
  tier:     permanent
  owner:    claude
  updates:  when a .claude/docs/ file is added, removed, renamed, or its tier/cap changes
  scope:    index + constitution for the AI-internal knowledge tree
  no-grow:  this file is a MAP, never a store — never duplicate another doc's content. Cap ~120 lines
  belongs:  the two-tree policy, the four tiers, the ownership table, navigation, adjacency
  excludes: any actual project facts (those live in the doc that owns them)
  migrates: if this exceeds ~120 lines, split the ownership table into its own file
-->

# `.claude/docs/` — AI-internal knowledge tree

This directory is **Claude's working memory** for the `cue` repo. It is optimized for
context restoration and continuity across long-lived, multi-session work. It is **not**
human documentation — human docs live in [`docs/`](../../docs/) and the root
[`README.md`](../../README.md). Never copy prose from those into here; link inward.

**Entry order on resume:** [`../../CLAUDE.md`](../../CLAUDE.md) (always loaded) →
[`context-summary.md`](context-summary.md) (regenerable refresher) → the task-specific
files named by [`retrieval-policy.md`](retrieval-policy.md).

## Two trees, one source of truth per fact

| Tree | Audience | Purpose |
|---|---|---|
| `.claude/docs/` (here) | Claude | operational working memory: invariants, seams, decisions, current state, policies |
| `docs/` (human) | developers | narrative architecture, contributing guide, release guide |

A given **fact has exactly one primary home.** The other tree may **link** to it, not
restate it. Example: `docs/architecture.md` owns the narrative "what the system is & why";
[architecture.md](architecture.md) here owns "what's safe to change & where the seams are."
Both reference the same code but ask different questions, so overlap is minimal.

## The four knowledge tiers

(Full lifecycle in [compression-policy.md](compression-policy.md))

- **permanent** — architecture, invariants, conventions. Changes only when the code
  changes. Files: [architecture](architecture.md), [conventions](conventions.md),
  [retrieval-policy](retrieval-policy.md), [compression-policy](compression-policy.md).
- **long-term** — decision rationale, recurring pitfalls, provider notes. Grows slowly,
  compressed regularly. Files: [decisions](decisions.md), [memory](memory.md),
  [providers](providers.md), [glossary](glossary.md), [troubleshooting](troubleshooting.md).
- **current** — phase progress, in-flight work, blockers. Per-session; **points at `git`
  for live state, never transcribes diffs.** Files: [state](state.md),
  [implementation-plan](implementation-plan.md).
- **compression** — a periodically-rewritten briefing; mostly pointers.
  File: [context-summary](context-summary.md).

**Session knowledge** has no permanent file. It lives in the conversation and, at most,
a short "in flight" subsection of [state.md](state.md); at commit time it is promoted into
`memory.md`/`decisions.md` and then cleared. See compression-policy.

## Ownership table

| File | Tier | Purpose | Update trigger | Cap |
|---|---|---|---|---|
| `README.md` | permanent | this index + constitution | add/remove/rename/tier-change a doc | ~120 lines |
| `architecture.md` | permanent | operational architecture + seams + blast radius | when a seam/invariant changes | ~140 lines |
| `conventions.md` | permanent | coding rules, invariants, gotchas | when a convention changes | ~120 lines |
| `providers.md` | long-term | per-provider notes (OpenAI/Anthropic/Gemini/Nvidia/Ollama, STT) | when a provider's integration changes | ~120 lines |
| `decisions.md` | long-term | compressed ADRs | when a decision is made/superseded | ≤25 **active** (superseded marked, then pruned) |
| `memory.md` | long-term | recurring pitfalls + lessons | end-of-feature; session→long-term promotion | ≤60 entries |
| `state.md` | current | branch progress / in-flight / next / blockers | per session; never transcribes diffs | ~80 lines |
| `implementation-plan.md` | current→long-term | phased roadmap + status | when a phase changes status | bound by roadmap; archive completed detail |
| `context-summary.md` | compression | regenerable orientation briefing | on resume / periodic rewrite | ~70 lines (rewritten, not appended) |
| `glossary.md` | long-term | terms | when a term is coined/removed | prune removed terms |
| `troubleshooting.md` | long-term | dev troubleshooting (not user — that's README) | when a pitfall recurs | ≤40 entries |
| `retrieval-policy.md` | permanent | task→docs matrix | when the doc set/structure changes | ~90 lines |
| `compression-policy.md` | permanent | rewrite-not-append rules + caps + cadence | when the compression model changes | ~120 lines |

## Adjacency (no overlap)

- **mem0 MCP** — optional *runtime* memory accelerator (enabled in `.claude/settings.json`).
  It is **not** the canonical store. This tree is the deterministic, reviewable source of
  truth; if mem0 and a doc disagree, the doc wins and mem0 should be corrected.
- **Harness memory** (`~/.claude/projects/.../memory/`) — cross-session *user*
  facts/preferences, a different domain from repo knowledge. No overlap.
- **`CLAUDE.md`** — the always-loaded router into this tree; it restates nothing here.
- **`docs/` + `README.md`** — human-facing; linked from here, never duplicated.

## How to update

1. Edit the smallest single doc that **owns** the fact (per the table).
2. If the fact lives elsewhere, edit there and link — don't restate.
3. Prefer **rewriting** a section over appending (see compression-policy).
4. On commit, promote any session discoveries from `state.md` "in flight" into
   `memory.md`/`decisions.md`, then clear the "in flight" entry.
5. If no existing doc owns a new fact, *first* ask whether one should; only create a new
   file when a genuinely new knowledge domain appears — then update this table.

Every file here opens with the same governance header
(tier / owner / updates / scope / no-grow / belongs / excludes / migrates). That header is the contract.
