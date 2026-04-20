# ROADMAP — js-git-store

Phased delivery. Each phase ends with a usable tag + a decision point.

---

## v0.1 — MVP (current scope)

**Theme**: one unified `GitStoreAdapter` that works for both `js-doc-store` and `js-vector-store` against a local `file://` remote.

### Scope

- `GitStoreAdapter` implementing the upstream sync + preload/persist contract
- Core modules: `git.ts`, `branch-router.ts`, `cache-layer.ts` (originally split as `blob-fetch.ts`, merged in v0.6), `commit-queue.ts`, `atomic-write.ts`
- Unit tests per TEST-PLAN.md
- Integration tests using **real** `DocStore(adapter)` and `VectorStore(adapter, dim)` against file:// bare repo fixtures
- Examples: `examples/skills-catalog/` (DocStore) and `examples/vector-rag/` (VectorStore)

### Success criteria

- All tests green on Linux, macOS, and Windows
- `examples/skills-catalog/` runs end-to-end against a local fixture bare repo
- Cold read of a 1,000-doc collection < 500 ms; warm < 50 ms
- Zero runtime deps (`npm ls --prod` clean)

### Out of scope

- Remote GitHub/GitLab auth in production (skeleton exists; hardening is v0.2)
- CF Workers support

---

## v0.2 — Remote auth + Matryoshka recall

### Scope

- HTTPS auth via `authEnvVar` with proper `GIT_ASKPASS` handling
- SSH auth via inherited `~/.ssh` config
- Redactor integrated into every git error surface
- Quantized-recall read optimization for vector store: load `.b1.json`/`.q8.json` from index branch, fetch full-precision `.bin` only for top candidates
- Integration test against a real private GitHub test repo using `GITHUB_TOKEN`

### Success criteria

- Successful clone from private GitHub repo using `GITHUB_TOKEN`
- Token never appears in logs, errors, or cache filenames
- Vector search on 100K × 768 with quantized-recall: p95 cold < 300 ms

---

## v0.3 — Operability

### Scope

- Prometheus metrics: blob fetches, cache hit rate, commit queue depth, git durations
- Structured logging events documented
- Graceful shutdown: `close()` flushes pending writes
- Backpressure: if commit queue exceeds a threshold, writes surface `BACKPRESSURE`
- `git gc` scheduling for local caches
- Benchmark suite in CI, regressions block merge

### Success criteria

- 24h soak test: no leaks, stable cache size, no corrupted commits
- Graceful SIGTERM: no commits lost, no locks leaked

---

## v1.0 — Stability

### Scope

- Freeze config field names
- Freeze error code set
- Migration guide: v0.x → v1.0
- External security audit
- Performance SLO gated in CI

### Success criteria

- Published to npm as `js-git-store`
- At least one public deployment using it (a2e-skills migration target)

---

## v2.0 — CF Workers support

### Scope

- Alternative transport: GitHub REST API for reads (no shell, no child_process)
- R2 / KV backed local cache for persistence across invocations
- Read-only at the edge; writes happen from a Node worker or CI process

### Why this is hard

- Workers can't run `git`. Everything through HTTPS APIs.
- Multiple API calls per blob; rate limits matter.
- LRU cache in KV has size limits and per-op cost.

---

## Principles

1. **Match upstream interface exactly.** If js-doc-store or js-vector-store evolve, this project matches, not leads.
2. **Every phase ships a working tag.** v0.1 is useful even if v0.2 never happens.
3. **Zero runtime deps is a constraint, not a goal.** If a genuine need appears, open an issue first.
4. **file:// is a first-class remote, forever.** Local dev, CI, offline — all supported.

---

## Explicitly out of roadmap

- SQL query layer. Use the host's native query operators.
- Schema migrations for repo layout. Bump a layout version explicitly if it evolves.
- Multi-repo federation. Each repo = one logical DB.
- Webhooks / real-time change notifications. Callers poll.
