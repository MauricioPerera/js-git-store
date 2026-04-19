# TEST-PLAN — js-git-store

Concrete test scenarios. Binary pass/fail. No aspirational "TODO tests".

## Unit tests (no git invocation)

### `tests/unit/git-args.test.ts`

Exercises the git command argument construction without running git.

- [ ] `runGit(["clone", url, dir], {cwd})` produces `argv = ["clone", url, dir]` with no shell interpretation
- [ ] Timeout option results in `AbortSignal` passed to `spawn`
- [ ] `authEnv` values are merged into env **for that call only** and do not leak into `process.env`
- [ ] `redactor` is invoked on stderr before it's included in thrown errors — tokens scrubbed
- [ ] Non-zero exit code produces `GitStoreError({code: "GIT_COMMAND_FAILED"})` with exit code + stderr preview

### `tests/unit/index-branch.test.ts`

Path computation and manifest shape.

- [ ] `collectionMetaPath("users")` === `"collections/users.meta.json"`
- [ ] `collectionDocsPath("users")` === `"collections/users.docs.jsonl"`
- [ ] `indexPath("users", "email")` === `"collections/users.idx.email.json"`
- [ ] `vectorCellPath("embeddings", 37)` === `"vectors/embeddings/cell-0037.vec.bin"` — zero-padded 4 digits
- [ ] `parseManifest(valid)` returns the manifest; invalid throws `INVALID_INDEX_SCHEMA`
- [ ] `buildManifest([cols], [vecCols])` produces JSON matching the documented schema

### `tests/unit/blob-cache.test.ts`

LRU semantics without filesystem.

- [ ] Inserting past `maxBytes` evicts least-recently-accessed
- [ ] `get()` updates access time, `put()` also updates
- [ ] `invalidate(path)` removes entry and frees bytes
- [ ] `size()` is accurate after inserts + evictions
- [ ] Two concurrent `get()` for the same path share a single fetch (in-flight coalescing)

### `tests/unit/commit-queue.test.ts`

Serialization.

- [ ] Two enqueued tasks run in FIFO order even when the second is submitted before the first awaits
- [ ] Task errors propagate to the caller but don't block subsequent tasks
- [ ] `drain()` resolves only after all tasks complete
- [ ] `size()` returns pending + running count

## Integration tests (real git, local file:// remote)

### Setup — `tests/fixtures/make-bare-repo.sh`

Creates a temporary bare repo with:
- `main` branch: sample collections + some vector cells
- `index` branch: matching manifest + index files
- Configurable corpus size via env vars

All integration tests use this via `file:///path/to/bare.git` to avoid network dependencies.

### `tests/integration/doc-adapter.test.ts`

Happy path:

- [ ] Fresh clone: `GitDocStoreAdapter` constructed with a file:// URL clones indexRef and is ready to read
- [ ] `readCollection("users")` fetches the docs blob on first call, serves from cache on second
- [ ] `writeCollection("users", [...newDocs])` creates a commit on `contentRef` locally
- [ ] `writeCollection` with `regenerateIndexHook` updates index branch files in the same commit
- [ ] `listCollections()` reads from the manifest
- [ ] `flush()` waits for the commit queue to drain

Error handling:

- [ ] Non-existent `indexRef` → `BRANCH_NOT_FOUND` on construction (eagerly validated)
- [ ] Missing auth env var when `authEnvVar` is set → `AUTH_MISSING`
- [ ] Network error during blob fetch (simulated via bad remote) → `BLOB_FETCH_TIMEOUT`
- [ ] Concurrent external write creating a non-fast-forward → `CONCURRENT_WRITE` on `push()`

Host library compatibility:

- [ ] The full js-doc-store FileStorageAdapter test suite passes when substituted with GitDocStoreAdapter against the fixture repo

### `tests/integration/vector-adapter.test.ts`

- [ ] `similaritySearch` with `rerankMode: "none"` fetches exactly `probes` cell blobs and returns top-K from those
- [ ] `similaritySearch` with `rerankMode: "quantized-recall"` uses local quantized vectors for initial scoring and only fetches full-precision cells for the top candidates
- [ ] Writing a vector causes its cell to be recomputed and the cell's blob rewritten
- [ ] IVF centroids in index branch are treated as authoritative — adapter does NOT re-cluster on every write
- [ ] Pinning `contentRef` to a SHA produces deterministic query results

### `tests/integration/concurrency.test.ts`

Cross-process write coordination.

- [ ] Two processes each trying to write the same collection serialize via flock
- [ ] Stale lock (older than configured timeout) is stolen and replaced
- [ ] Lock acquisition beyond `gitTimeoutMs` raises `LOCK_TIMEOUT`

## Performance / smoke benchmarks

Not part of the correctness suite. Recorded in `tests/bench/` with output to `bench-results.json`.

### `tests/bench/cold-read.mjs`

- Clone the fixture repo (1,000-doc collection) cold, read a random doc, measure end-to-end.
- Target: < 500 ms on first read, < 20 ms on cached reads.

### `tests/bench/vector-search.mjs`

- Dataset: 100,000 vectors at 768 dims (Float32), IVF with 100 cells, 5 probes.
- Target: p95 latency for `similaritySearch` under 300 ms cold, 50 ms warm.

## Test data fixtures

Under `tests/fixtures/sample-corpora/`:

1. `small-docs/` — 10 collections × 100 docs each. Used for fast unit-adjacent integration tests.
2. `medium-vectors/` — 1,000 vectors × 128 dims. Fits in memory, tests IVF correctness.
3. `realistic-kb/` — 5,000 docs + 5,000 vectors × 768 dims. Used for bench.

The fixtures are generated by a script (`tests/fixtures/generate.ts`), not committed. The script is deterministic (seeded), so fixtures regenerate identically.

## What we do NOT test

- Network flakiness at the TCP level. Simulated via mock remote that delays/errors on request.
- Cross-platform. Target Linux CI + macOS dev. Windows via WSL (not native — git behavior differs).
- GitHub-specific features (LFS, commit signing policies, branch protection). Those are infra concerns, not library concerns.

## Acceptance: what "green" means

All tests pass, typecheck passes, lint passes, benchmarks meet targets. A single regression in any category blocks a release.
