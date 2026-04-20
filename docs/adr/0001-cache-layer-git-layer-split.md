# ADR-0001 — Split the adapter god-object into CacheLayer + GitLayer

- **Status**: Accepted
- **Date**: 2025-12 (retroactive — change shipped in v0.6, recorded
  here in v1.1 when the ADR practice was adopted)
- **Supersedes**: —

## Context

Through v0.5, `src/adapters/git-store.ts` had grown to ~399 lines and was
coordinating eight distinct concerns:

1. The in-memory cache (`Map`, byte accounting, LRU touch, dirty tracking)
2. The two on-disk worktrees (content + index)
3. Clone / init lifecycle
4. The in-process commit queue + cross-process file lock
5. Stage / commit / push / refresh / `gc`
6. Background `gc` timer scheduling
7. Auth env propagation + token redactor wiring
8. Metrics + structured logging emission for all of the above

The 400-line cap that `CONTRACT.md §6` set for this file (already bumped
from 350 in v0.3) was about to be breached again as v0.5 P3 added
`cacheEntryCount()`, the SHA-pin guard, and the cross-instance flock test.
Adding any further responsibility (planned: Worker transport) without
extracting first would have produced a file no one could meaningfully
review in one pass.

## Decision

The adapter is split into two focused layers plus a thin composition
adapter:

- **`src/core/cache-layer.ts`** owns concern (1) only. In-memory `Map`,
  O(1) byte accounting, LRU touch, dirty / tombstone semantics. No git,
  no FS, no network. Unit-testable in isolation.
- **`src/core/git-layer.ts`** owns concerns (2)–(7). Both worktrees,
  clone lifecycle, commit queue + flock, stage / commit / push /
  refresh / gc, background gc timer, auth forwarding.
- **`src/adapters/git-store.ts`** is now a thin composition: it
  implements the upstream `StorageAdapter` interface by delegating to
  the two layers, plus the metrics/log wiring (concern 8).

Direction is strictly `adapters/` → `core/`. No back-edges.

Line counts after the split (per CHANGELOG v0.6 entry):

| File | LOC |
|---|---|
| `cache-layer.ts` | 135 |
| `git-layer.ts` | 186 |
| `git-store.ts` | 189 (down from 399, −53 %) |

## Consequences

- ✅ Each file has one responsibility and fits in a single review pass.
- ✅ `CacheLayer` is unit-testable without spawning git (13 new unit
  tests in `tests/unit/cache-layer.test.ts`).
- ✅ Future Worker transport (v2.0) can substitute `git-layer.ts` with a
  REST-backed implementation without touching the cache or the adapter.
- ⚠️ Total `src/` LOC went up (995 → 1117) because layer boundaries cost
  some interface surface. Accepted.
- ⚠️ Two extra files to keep in sync when the adapter contract changes.
- ❌ The original `core/blob-fetch.ts` module was inlined into
  `cache-layer.ts` rather than kept as a third layer. See ADR-0002 (when
  written) for the rationale; in short, blob-fetch had no consumer
  outside the cache and the indirection was buying nothing.

## Alternatives considered

- **Keep the god-object, just bump the cap to 500 lines.** Rejected — we
  already bumped it once; this is the symptom of structural debt, not a
  budgeting problem. A second bump would make the cap meaningless.
- **Three layers (cache / blob-fetch / git-orchestration).** Rejected:
  `blob-fetch.ts` had no consumer outside the cache and its existence
  was creating duplicate cache state. Inlined into `cache-layer.ts`.
- **Extract metrics into its own layer.** Rejected: metrics are
  cross-cutting; making them their own layer would have produced a
  fourth file that everyone has to import. They live in the layer that
  emits them.

## References

- CHANGELOG: `[Unreleased] — v0.6 architecture refactor (god-object split)`
- Behavioural invariants verified: all 85 prior tests pass unchanged.
- New tests: `tests/unit/cache-layer.test.ts` (13 cases).
