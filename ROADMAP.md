# ROADMAP — js-git-store

Phased delivery. Each phase ends with a usable tag + a decision point. The
**Status** column tracks reality (CHANGELOG); the **Gap** column lists what
is still owed against the original success criteria.

> Architectural changes that emerge mid-phase (e.g. the v0.6 god-object
> split) should land here as ADRs first (`docs/adr/`) — not appear only
> in CHANGELOG after the fact. See [docs/adr/README.md](docs/adr/README.md).

---

## v0.1 — MVP

**Theme**: one unified `GitStoreAdapter` that works for both `js-doc-store`
and `js-vector-store` against a local `file://` remote.

| Item | Status |
|---|---|
| `GitStoreAdapter` matching upstream sync + preload/persist | ✅ |
| Core modules (`git`, `branch-router`, `cache-layer`, `commit-queue`, `atomic-write`) | ✅ (`blob-fetch` later inlined into `cache-layer` in v0.6) |
| Unit + integration tests against file:// fixtures | ✅ |
| Examples (`skills-catalog`, `vector-rag`) | ✅ |
| Cold read 1000 docs < 500 ms / warm < 50 ms (Linux) | ✅ gated in CI (`BENCH_GATE=1`) |
| Zero runtime deps | ✅ |

---

## v0.2 — Remote auth

**Theme**: production-grade HTTPS auth with token redaction.

| Item | Status |
|---|---|
| HTTPS via `authEnvVar` + `http.extraHeader Basic` | ✅ |
| SSH via inherited `~/.ssh` config | ✅ (transparent — git inherits) |
| Token + base64 redactor on every git error surface | ✅ |
| E2E against real private GitHub repo | ✅ (`tests/scripts/github-e2e.ts`) |

> **Removed from this phase**: the original draft mentioned "Matryoshka
> recall optimization for vector store". That belongs to `js-vector-store`,
> not the adapter — the adapter only moves bytes (`readBin`/`writeBin`).
> Tracked upstream.

---

## v0.3 — Operability

**Theme**: metrics, backpressure, GC, soak harness.

| Item | Status |
|---|---|
| Metrics (`gitstore.blob.fetch`, `gitstore.commit`, `gitstore.persist`, …) | ✅ |
| Structured logging events documented | ✅ (see API.md) |
| Graceful `close()` flushes pending writes | ✅ |
| `BACKPRESSURE` when commit queue exceeds threshold | ✅ |
| `git gc --auto` on demand + `gcIntervalMs` background | ✅ |
| Bench suite **gated in CI** | ⚠️ only `cold-read` was gated until v1.1 work — see Gap below |
| 24h soak: no leaks, stable cache, no corrupted commits | ⚠️ harness exists; only 60s default has been executed in CI; weekly `soak.yml` runs short |

**Gap → addressed in v1.1 (current)**: the 3 newer benches (`vector-load`,
`persist-throughput`, `cache-eviction`) are now also gated in CI. A
documented 24h soak run is still owed; tracked as a one-time validation
task, not a recurring feature.

---

## v1.0 — Stability

**Theme**: freeze the public surface; make the package publishable.

| Item | Status |
|---|---|
| STABILITY.md (frozen API, error codes, metrics, log events) | ✅ |
| SECURITY.md (threat model, redaction guarantees) | ✅ |
| `publishConfig.access: public`, `exports` map, `sideEffects: false` | ✅ |
| Bench gate hard-fails CI on Linux | ✅ (single bench so far) |
| **Published to npm** | ❌ **not done** — last gate to call v1.0 truly shipped |
| At least one public deployment (a2e-skills migration) | ⏳ deferred (consumer-side work) |
| External security audit | ⏳ deferred (requires human expert) |

---

## v1.0.1 — Hardening + perf (shipped, was unplanned)

Reactive release driven by a code review. See CHANGELOG.

- Path-traversal rejection on every public surface
- `preload()` parallelization + in-flight coalescing
- Batched `git add` per branch
- `readBinShared` zero-copy variant
- Persist metrics

---

## v1.1 — Validation closure (in flight)

**Theme**: close the success-criteria gaps that v1.0 left open.

| Item | Owner |
|---|---|
| Gate `vector-load` / `persist-throughput` / `cache-eviction` benches in CI | this repo |
| One documented 24h soak run on Linux, results checked in under `docs/soak/` | this repo |
| Add `docs/adr/` directory + retroactive ADR-0001 for the v0.6 split | this repo |
| `npm publish` v1.0.x | this repo (after gates green) |

Exit criterion: v1.0 success table above is fully ✅.

---

## v2.0 — CF Workers transport

**Theme**: read-only edge deployment via the GitHub REST API instead of
spawning `git`.

This is large. Decomposed into milestones rather than one monolithic phase:

### v2.0-M1 — `Transport` interface

- Extract the surface that `git-layer.ts` consumes (clone, fetch blob,
  list refs, read tree, push) into a `Transport` interface.
- Refactor `core/git.ts` to be one implementation: `SpawnTransport`.
- All existing tests pass unchanged.

### v2.0-M2 — `RestTransport` (read-only)

- Implement `Transport` against GitHub REST (`/repos/.../contents`,
  `/git/blobs`, `/git/trees`).
- Token auth via the same `authEnvVar` plumbing.
- Rate-limit aware (per-token quota, exponential backoff on 429/403).
- Adapter gains a `transport: "spawn" | "rest"` config knob.
- Read-path tests reuse the existing fixture suite by pointing them at a
  mock REST server.

### v2.0-M3 — KV/R2 cache

- Replace the FS-backed `localCacheDir` with a pluggable `CacheStore`
  interface; ship two implementations: `FsCacheStore` (today) and
  `KvCacheStore` (CF KV / R2).
- Eviction respects per-op cost and KV size limits.

### v2.0-M4 — Worker example + docs

- `examples/cf-worker-rag/` — read-only RAG endpoint at the edge.
- Document the deployment topology (writes from CI/Node, reads from edge).

**Why this is hard** (kept from the original): Workers can't run `git`,
multiple API calls per blob, rate limits matter, KV cache has size limits
and per-op cost.

---

## Beyond v2.0 — explicitly deferred

Not committed; listed so contributors know they are on the radar:

- **LFS support** — pointer-aware blob fetch path.
- **Commit signing** (GPG/SSH) — requires either spawning `gpg` or signing
  via REST.
- **Sparse checkout** for repos with millions of files where even a
  partial clone is too large.
- **Conflict resolution strategy** for multi-writer scenarios beyond the
  current "non-fast-forward → CONCURRENT_WRITE" surface.
- **Pack-file size observability** — surface as a metric so callers know
  when to trigger `gc()`.

---

## Principles

1. **Match upstream interface exactly.** If `js-doc-store` or
   `js-vector-store` evolve, this project matches, not leads.
2. **Every phase ships a working tag.** v0.1 is useful even if v0.2 never
   happens.
3. **Zero runtime deps is a constraint, not a goal.** If a genuine need
   appears, open an issue first.
4. **`file://` is a first-class remote, forever.** Local dev, CI, offline
   — all supported.
5. **Architectural changes get an ADR.** If a refactor crosses module
   boundaries or changes a contract in `CONTRACT.md`, it lands as a
   numbered ADR before code, even retroactively for changes already in
   `main`.

---

## Explicitly out of roadmap

- SQL query layer. Use the host's native query operators.
- Schema migrations for repo layout. Bump a layout version explicitly if
  it evolves.
- Multi-repo federation. Each repo = one logical DB.
- Webhooks / real-time change notifications. Callers poll.
- Vector-search algorithms (Matryoshka, IVF, PQ). Belong upstream in
  `js-vector-store`; this adapter only stores bytes.
