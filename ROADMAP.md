# ROADMAP — js-git-store

Phased delivery. Each phase ends with a usable tag + a decision point.

---

## v0.1 — MVP (the coding agent's immediate scope)

**Theme**: make the doc adapter work against a single local file:// remote, enough to migrate a2e-skills off its manual CI-driven index regeneration.

### Scope

- `GitDocStoreAdapter` with all methods in the upstream js-doc-store `StorageAdapter` interface
- Core modules: `git.ts`, `index-branch.ts`, `blob-fetch.ts`, `commit-queue.ts`, `atomic-write.ts`
- Unit tests: full list in TEST-PLAN.md
- Integration tests: `doc-adapter.test.ts` + `concurrency.test.ts` against file:// bare repos
- One example: `examples/skills-catalog/` — script that imports a2e-skills' current content into the adapter and verifies queries still work
- README + CHANGELOG initialized

### Success criteria

- All tests green on Linux + macOS
- `examples/skills-catalog/` runs end-to-end against a local fixture clone of a2e-skills
- Cold read of a 1,000-doc collection < 100 ms
- Zero runtime deps verified via `npm ls --prod`

### Out of scope

- Vector adapter (deferred to v0.2)
- Remote GitHub/GitLab auth (file:// only in v0.1)
- CF Workers compatibility

---

## v0.2 — Vector adapter + remote auth

**Theme**: enable vector search and real network remotes.

### Scope

- `GitVectorStoreAdapter` with IVF cell routing + quantized recall re-rank
- `examples/vector-rag/` — RAG over a git-backed vector store, using Cloudflare Workers AI for embeddings (or any provider — pluggable)
- HTTPS auth via `authEnvVar` with proper `GIT_ASKPASS` handling
- SSH auth via inherited `~/.ssh` config
- Redactor integrated into every git error surface
- Integration test: `vector-adapter.test.ts` against file:// + HTTPS (using a private GitHub test repo created specifically for CI)

### Success criteria

- `similaritySearch` with 100K vectors × 768 dims: p95 < 300 ms cold, 50 ms warm
- Successful clone from private GitHub repo using `GITHUB_TOKEN` env var
- Token never appears in logs, errors, or cache filenames

### Out of scope

- CF Workers runtime support
- Matryoshka full multi-stage (only two-stage: quantized-recall + full-precision)

---

## v0.3 — Operability

**Theme**: production-readiness without changing the core contract.

### Scope

- Prometheus metrics export (opt-in): blob fetches, cache hit rate, commit queue depth, git durations
- Structured logging events documented in ARCHITECTURE.md
- Graceful shutdown: `flush()` + `close()` + WAL-style recovery for partial writes
- Backpressure: if commit queue exceeds a threshold, writes return `BACKPRESSURE` instead of queuing indefinitely
- `git gc` scheduling: local caches repack periodically
- Benchmark suite in CI, regressions block merge

### Success criteria

- 24h soak test with realistic read/write mix: no memory leaks, stable cache size, no corrupted commits
- Metrics endpoint produces valid Prometheus output
- Graceful SIGTERM handling: no commits lost, no locks leaked

### Out of scope

- Replication / multi-remote push
- CF Workers support

---

## v1.0 — Stability

**Theme**: freeze the API. Publish to npm. Call it done.

### Scope

- Schema lock for the index branch layout (manifest + partition shapes)
- Error code set locked
- Config fields locked
- Migration guide: v0.x → v1.0
- Security audit (external, similar to the one a2e-shell needs for its own v1.0 final)
- Performance SLO documented and gated in CI

### Success criteria

- Published to npm under `js-git-store`
- At least one public deployment using it (a2e-skills migration, or similar)
- No breaking changes possible without bumping to v2.0 under a different package name

---

## v2.0 — CF Workers support

**Theme**: run the adapter in edge environments.

### Scope

- Alternative transport: GitHub REST API for reads (no shell, no child_process)
- R2 / KV backed local cache for persistence across Worker invocations
- Trade-offs clearly documented: Workers version has no write support for the content branch (read-only at the edge, writes happen from a Node worker or CI process)

### Why this is hard

- Workers can't run `git`. Everything has to go through HTTPS APIs.
- Tree+blob fetching requires multiple API calls per blob, rate limits matter.
- LRU cache in KV has size limits and per-op cost.

### Out of scope

- Write support from Workers (contentious; deferred indefinitely)

---

## Principles guiding the roadmap

1. **Never break the StorageAdapter contract unilaterally.** If js-doc-store or js-vector-store evolve their interfaces, this project matches, not leads.
2. **Every phase has a shippable tag.** v0.1 is useful even if v0.2 never happens.
3. **Zero runtime deps is a constraint, not a goal.** If a genuine need for a dep appears, open an issue and discuss publicly before adding it.
4. **File:// is a first-class remote, forever.** Local development, CI, and offline use cases all benefit.

---

## Explicitly out of roadmap

- SQL query layer. Use js-doc-store's native query operators.
- Schema migrations. Version the index branch layout explicitly if it evolves.
- Multi-repo federation. Each repo = one logical DB. Compose at the application layer, not the adapter.
- Real-time change notifications (webhooks, websockets). Callers poll via `git fetch` or GitHub webhooks if needed.
