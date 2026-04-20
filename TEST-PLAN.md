# TEST-PLAN — js-git-store

Concrete test scenarios. Binary pass/fail.

## Unit tests (no git invocation)

### `tests/unit/git-args.test.ts`

- [ ] `runGit(["clone", url, dir], {cwd})` produces `argv = ["clone", url, dir]` with no shell interpretation
- [ ] `authEnv` values are merged for that call only and do NOT leak into `process.env`
- [ ] Non-zero exit code produces `GitStoreError({code: "GIT_COMMAND_FAILED"})`
- [ ] `redactor` scrubs the token from stderr AND from the argv section of the error message
- [ ] Timeout produces a `GIT_COMMAND_FAILED` with "timed out" in the message

### `tests/unit/branch-router.test.ts`

- [ ] Default `heavyFileRegex` matches `users.docs.json`, `articles.bin`, `index.q8.bin`
- [ ] Default regex does NOT match `users.meta.json`, `articles.idx.json`, `index.json`
- [ ] Custom regex overrides the default
- [ ] `routerFor(regex).branchOf(filename)` returns `"content"` | `"index"` predictably

### `tests/unit/blob-cache.test.ts`

- [ ] Inserting past `maxBytes` evicts least-recently-accessed
- [ ] `get()` updates access recency; `put()` does too
- [ ] `invalidate(path)` removes entry and frees bytes
- [ ] Two concurrent `fetch()`s for the same path share a single in-flight promise

### `tests/unit/commit-queue.test.ts`

- [ ] Two enqueued tasks run FIFO even when the second is submitted before the first awaits
- [ ] Task errors propagate but don't block subsequent tasks
- [ ] `drain()` resolves only after all tasks complete
- [ ] `FileLock.acquire` times out with `LOCK_TIMEOUT` when another holder blocks
- [ ] Stale lock older than `staleMs` is stolen

## Integration tests (real git, file:// remote)

### Setup — `tests/fixtures/make-bare-repo.ts`

Cross-platform (TypeScript). Creates a temp bare repo with:

- `main` branch: seeded with `<col>.docs.json` for two collections
- `index` branch: seeded with `<col>.meta.json` for the same collections
- `uploadpack.allowFilter=true` on the bare repo so partial clone works against `file://`

All integration tests consume this helper.

### `tests/integration/git-store.test.ts`

Targets `DocStore(adapter)` from js-doc-store, run against a fixture bare repo.

Happy path:

- [ ] Fresh `GitStoreAdapter` → `preload([...])` succeeds and caches the listed files
- [ ] `db.collection("users").find({...}).toArray()` returns the seeded docs
- [ ] `insert()` + `db.flush()` + `adapter.persist()` creates commits on BOTH branches when warranted
- [ ] Re-reading the same repo in a second adapter instance sees the committed inserts
- [ ] `createIndex("email")` causes the index file to persist to the index branch (light)
- [ ] Docs JSON persists to the content branch (heavy)
- [ ] `listCollections()` via `db.collections()` reflects the host's in-memory state

Error handling:

- [ ] Missing `indexRef` → `BRANCH_NOT_FOUND` on preload
- [ ] `authEnvVar` set but env var unset → `AUTH_MISSING`
- [ ] Reading a never-preloaded, never-written filename returns `null` (matches upstream contract)
- [ ] Push rejected as non-fast-forward → `CONCURRENT_WRITE`

### `tests/integration/vector-store.test.ts`

Targets `VectorStore(adapter, dim)` from js-vector-store.

- [ ] `readBin`/`writeBin` round-trip an `ArrayBuffer` correctly
- [ ] After `persist`, the `.bin` file lands on the content branch, the `.json` on the index branch
- [ ] Pinning `contentRef` to a SHA produces deterministic data

### `tests/integration/concurrency.test.ts`

- [ ] Two adapter instances in the same process serialize persists correctly
- [ ] Stale lock is stolen and replaced
- [ ] Lock acquisition beyond `lockTimeoutMs` raises `LOCK_TIMEOUT`

## Performance / smoke benchmarks

Optional, not part of the correctness suite.

### `tests/bench/cold-read.mjs`

- Clone a 1,000-doc fixture cold, preload, measure end-to-end. Target: < 500 ms.

### `tests/bench/vector-search.mjs`

- 10,000 vectors × 768 dims. Target p95 < 300 ms cold, 50 ms warm.

## What we do NOT test

- Network flakiness at TCP level
- GitHub-specific features (LFS, commit signing policies, branch protection)
- CF Workers — deferred

## Acceptance

All tests pass, typecheck passes, lint passes. Benchmarks recorded, not gating.
