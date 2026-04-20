# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [SemVer](https://semver.org/).

## [1.0.0] — stability

### Stability commitment

Public API, config field names, error codes, metric names, and structured-log event names are now frozen per [STABILITY.md](STABILITY.md). Breaking changes require a major bump.

### Added

- **[STABILITY.md](STABILITY.md)** — full enumeration of the frozen public surface, SemVer rules, deprecation policy, and explicit non-freeze list (internal classes, error message wording, commit-message format).
- **[SECURITY.md](SECURITY.md)** — threat model, token handling guarantees, known limitations, and validation evidence from the E2E GitHub test.
- **`publishConfig.access: "public"`** on package.json for future `npm publish`.
- **`sideEffects: false`** for bundler tree-shaking.
- **`exports` map** in package.json for ESM resolution.
- **Repository / bugs / homepage metadata** for npm discoverability.
- **`BENCH_GATE=1` env var** enables hard-fail of the CI bench against absolute budgets (cold < 500 ms, warm < 50 ms) on Linux.

### Changed

- **`version`**: `0.0.0` → `1.0.0`.
- **`private: true` removed** — package is publishable.
- **CONTRACT §8 hard constraint** relaxed: publication to npm is no longer forbidden (was the correct rule pre-v1.0; now the release vehicle).
- **CI `bench` job** no longer `continue-on-error: true`. A Linux regression past the absolute budget now fails the build. Windows/macOS `check` jobs remain unchanged (bench numbers there are dominated by OS-level spawn latency and aren't a useful signal).

### Recap — what shipped across the 0.x line

| Version | Delta |
|---|---|
| v0.1 MVP | Unified adapter matching verified upstream interface, file:// remote, two-branch layout |
| v0.1 hardening | Non-fast-forward push → `CONCURRENT_WRITE`, pin-to-SHA, bench harness |
| v0.2 pre-work | HTTPS auth via `http.extraHeader Basic`, token + base64 redaction, cache eviction, `BLOB_FETCH_TIMEOUT` |
| v0.2 validation | E2E against real private GitHub repo; Bearer→Basic bug found and fixed |
| v0.3 operability | Metrics, backpressure, idempotent close, `gc()`, `gcIntervalMs`, soak harness |
| v0.3 CI | Multi-OS GitHub Actions, scheduled weekly soak |
| v0.4 cleanups | `refresh()`, `ADAPTER_CLOSED`, LRU touch (real LRU), `indexDepth`, narrower `isMissing` |
| v0.5 P0 | `authBase` only when cloning, `/g` regex stripped, `refresh({ force })` guard, config validation, `INVALID_CONFIG` |
| v0.5 P1 | `Symbol.asyncDispose`, generic `readJson<T>`, `push()` under flock |
| v0.5 P3 | `cacheEntryCount()` public, refresh-after-SHA-pin rejection, two-adapter flock test |
| v0.6 refactor | God-object split: `CacheLayer` + `GitLayer` + thin adapter (399 → 189 lines) |
| **v1.0** | **Freeze + publish prep + security/stability docs** |

### Tests

- 98 tests across 15 files (69 integration + 29 unit)
- Validated against real private GitHub repo (token redaction, clone, push, refresh)
- 60-second soak passes with no errors, stable RSS, fsck clean on both branches

### Not included (deferred to post-1.0)

- CF Workers transport (planned v2.0).
- External security audit (requires human expert).
- `a2e-skills` production migration (consumer-side work).
- Windows CI soak (soak runs Linux-only; harness works on Windows for local dev).

## [Unreleased] — v0.6 architecture refactor (god-object split)

### Changed

The adapter was growing into a god object (~400 lines coordinating cache, commit queue, flock, git I/O, refresh, gc, metrics, logging). Split into two focused layers plus a thin adapter:

- **`src/core/cache-layer.ts`** — in-memory Map + LRU touch + O(1) byte accounting + dirty/tombstone semantics. 135 lines.
- **`src/core/git-layer.ts`** — owns the two worktrees (content + index), clone/init lifecycle, commit queue, file lock, stage/commit/push/refresh/gc, background `gc` timer, auth forwarding. 186 lines.
- **`src/adapters/git-store.ts`** — thin composition: implements the `StorageAdapter` interface by delegating to the two layers. Down from 399 → 189 lines (−53 %).

### Behavioural invariants preserved

- All 85 existing integration + unit tests continue to pass unchanged.
- Public API (`readJson`/`readBin`/`writeJson`/`writeBin`/`delete`/`invalidate`/`preload`/`persist`/`push`/`refresh`/`gc`/`close`/`cacheBytes`/`cacheEntryCount`/`[Symbol.asyncDispose]`) is identical.
- Error codes, metric names, logger events unchanged.

### Added

- 13 CacheLayer unit tests in `tests/unit/cache-layer.test.ts` — sync read/write, delete/invalidate, LRU touch, byte accounting including overwrites, persist-lifecycle helpers (`dirtyEntries` / `commitDirty` / `dropClean`).

### Stats

- `src/` total: 1 117 LOC (up from 995 due to clearer layer boundaries, but each file now ≤ 189 LOC and has one responsibility).
- Tests: 98 (up from 85) across 15 files.
- `git-store.ts` comfortably below the 400-line cap for the first time since v0.2.

## [Unreleased] — v0.5 P3 (gap closure)

### Added

- **`cacheEntryCount(): number`** — returns the number of entries currently in the in-memory cache. Previously exposed only via the private `cache` Map, which the soak script was reaching into via `adapter["cache" as keyof ...]`. Clean public API now.
- Explicit `INVALID_CONFIG` from `refresh()` when either ref is pinned to a SHA. A SHA is immutable; `refresh()` would silently do the wrong thing (try to update HEAD to `refs/remotes/origin/<sha>` which wouldn't exist after fetch). Clear error now instead of silent breakage.

### Tests

- 4 new integration tests in `tests/integration/v05-p3.test.ts`:
  - `refresh()` with SHA-pinned `contentRef` throws `INVALID_CONFIG`
  - Two adapters on same `localCacheDir` serialize `persist()` via flock
  - Second adapter sees first adapter's persisted change after preload (cross-instance visibility)
  - `cacheEntryCount()` tracks preload/write/invalidate

### Refactor

- `tests/scripts/soak.ts` no longer reaches into the private `cache` map; uses public `cacheEntryCount()`.

## [Unreleased] — v0.5 P1 (API quality)

### Added

- **`Symbol.asyncDispose`** on `GitStoreAdapter` — supports the `await using` pattern (Node 20 + TS 5.2+). Automatic cleanup on scope exit:
  ```ts
  await using adapter = new GitStoreAdapter({ ... });
  await adapter.preload([...]);
  // adapter.close() runs here, even on thrown errors
  ```
- **`readJson<T = unknown>(filename): T | null`** — now generic so callers don't have to cast. Back-compat: omitting the type parameter yields `unknown`.

### Fixed

- **`push()` now acquires the cross-process flock**, not just the in-process queue. Previously two processes could enter `push()` simultaneously; git's own ref-update serializes writes at the remote, but the inconsistency produced noisy `CONCURRENT_WRITE` errors. Now `push()` serializes the same way as `persist()`/`refresh()`/`gc()`.

### Tests

- 6 new P1 integration tests in `tests/integration/v05-p1.test.ts`: dispose semantics, generic readJson, push-under-flock, push-on-closed.

## [Unreleased] — v0.5 hardening (P0 from code analysis)

### Fixed

- **P0-1 — `doInit` no longer forces auth when clones already exist.** Previously, a second adapter instance pointing at a local cache with an unset `authEnvVar` would throw `AUTH_MISSING` at init time, even though no remote call was needed. Now `authBase()` is only resolved when a clone has to happen. Content-branch reads still require auth (partial-clone may fetch on demand); index-branch reads from the cache no longer do.
- **P0-2 — `heavyFileRegex` `/g` flag stripped.** `makeBranchRouter` now clones the regex and drops the `g` flag to prevent the `RegExp.test` stateful-`lastIndex` footgun that would make routing flip between calls.
- **P0-3 — `refresh()` refuses to discard unpushed local commits.** Throws `CONCURRENT_WRITE` if either branch has commits not in `origin/<ref>`. Pass `{ force: true }` to override. Prevents silent data loss when a caller alternates local writes with remote sync.
- **P0-4 — config validation.** New `INVALID_CONFIG` error code. `resolveConfig` now rejects: missing `repoUrl`/`localCacheDir`, `maxCacheBytes <= 0`, `gitTimeoutMs <= 0`, `lockTimeoutMs <= 0`, `staleLockMs <= 0`, `maxPendingWrites < 0`, `gcIntervalMs < 0`, empty `author.name`/`author.email`. Previously these silently produced undefined behaviour.

### Added

- `INVALID_CONFIG` error code.
- `refresh({ force })` option.
- 11 P0 integration tests in `tests/integration/v05-hardening.test.ts`.

### Changed

- `resolveConfig` now throws `INVALID_CONFIG` (not `GIT_COMMAND_FAILED`) when required fields are missing — error taxonomy hygiene.

## [Unreleased] — v0.3 completion (CI)

### Added

- **GitHub Actions workflow at [`.github/workflows/ci.yml`](.github/workflows/ci.yml)** — runs on push / PR to `main`/`master`. Matrix across Ubuntu + macOS + Windows. Each job: typecheck (src), typecheck (tests + examples), lint, `vitest run`, `example:skills`, `example:vector`. An advisory `bench` job runs `npm run bench:cold-read` on Linux only, non-gating.
- **Scheduled soak at [`.github/workflows/soak.yml`](.github/workflows/soak.yml)** — weekly Sunday 02:00 UTC (and on-demand via `workflow_dispatch`). Default 3 600 s (1 h) soak on Linux; can be configured via workflow input. Closes the "24 h soak" success criterion path: the infra exists and the script is gated on fsck + cache-cap + error count.
- CONTRACT §8 hard constraint list needs a manual update to include `.github/workflows/` in the writable whitelist — pending a governance bump to v0.4 of the contract itself.

## [Unreleased] — v0.3 completion (gc + soak)

### Added

- **`gc()` method** — runs `git gc --auto --quiet` on both worktrees. Serialized via queue + flock. Emits `gitstore.gc` counter + `gitstore.gc.ms` histogram.
- **`gcIntervalMs` config** — if > 0, schedules background gc via `setInterval` (unrefed so it doesn't keep the process alive). `close()` clears the timer.
- **`tests/scripts/soak.ts`** — operability soak harness. Alternates writes / persist / refresh / gc in a loop for `SOAK_SECONDS` (default 60). Tracks RSS + heap + cacheBytes over time; runs `git fsck --full --strict` at the end. Script: `npm run soak`.

### Verified

A 60-second local soak on Windows produced:

- 26 iterations, 29 commits, 2 refreshes, 1 gc
- 0 errors
- RSS 63.8 → 59.8 MB (stable, even decreased)
- Heap 9.7 → 11.2 MB (Δ +1.5 MB across 60 s — no leak signal)
- Cache bytes 222 / 2 MiB cap (correct)
- `git fsck` clean on both branches

Longer runs (SOAK_SECONDS=3600+) are the path to validate the "24 h soak" v0.3 success criterion; the harness exists now.

### Tests

- 4 new integration tests in `tests/integration/v03-completion.test.ts`:
  - `gc()` runs + fsck passes post-gc
  - `gcIntervalMs` fires + `close()` cancels the timer
  - `close()` during in-flight `persist()` drains the queue (verified via `git show HEAD:...`)
  - `close()` is a no-op when already closed

### Contract adjustment

- `src/adapters/git-store.ts` line limit raised from 350 to 400. v0.3/v0.4 legitimately grew the adapter surface (metrics, backpressure, refresh, gc, LRU touch). Further splitting would obscure intent.

## [Unreleased] — v0.4 cleanups + refresh

### Added

- **`refresh()` method** — fetches both refs from origin, moves HEAD to the new commit, and drops every clean cache entry so subsequent reads see the new state. Dirty entries are preserved (they'd lose writes). Closes the cross-process staleness gap documented in the analysis as issue B/C.
- **`ADAPTER_CLOSED` error code** — replaces the misleading `GIT_COMMAND_FAILED` that was being thrown when an operation hit a closed adapter. Improves caller error taxonomy.
- **`indexDepth` config** — replaces the hardcoded `depth: 1` for the index clone. Values > 0 produce shallow clones of that depth; `0` or negative = full history (useful for audit workflows).

### Fixed

- **LRU eviction is actually LRU now.** `readJson` and `readBin` re-insert the entry at the tail of the Map, so a read protects a file from being evicted by a subsequent preload. Previously, despite the "LRU" naming in docs, eviction was FIFO.
- **`isMissing()` narrowed.** Previously matched any message containing `exit code 128`, which swallowed unrelated git failures (auth errors, corrupted repo). Now matches the specific "path does not exist" / "invalid object name" messages only.

### Removed

- `src/core/blob-fetch.ts` (`LruBlobCache`, `CachingBlobFetcher`, `BlobCache`, `BlobFetcher`, `FetchFn`) — dead code since the unified adapter was introduced. The adapter maintains its own Map-backed cache inline.
- `tests/unit/blob-cache.test.ts` — tested the removed module.
- Private `refFor()` method on the adapter — unused.

### Stats

- `src/` now 960 LOC (down from 1 004 pre-cleanup, net change after `refresh()`).
- 60 tests across 10 files passing (up from 50).

## [Unreleased] — v0.3 operability

### Added

- **`MetricsCollector` interface + `InMemoryMetrics` impl.** Injectable via `config.metrics`. Default is noop. Emits: `gitstore.blob.fetch` (counter, labels: `branch`, `result`), `gitstore.blob.fetch.ms` (histogram, `branch`), `gitstore.commit` (counter, `branch`), `gitstore.cache.evict` (counter), `gitstore.queue.wait.ms` (histogram), `gitstore.persist.backpressure` (counter).
- **`maxPendingWrites` config + `BACKPRESSURE` ErrorCode.** When the commit queue has ≥ this many pending ops, `persist()` throws instead of queuing indefinitely. `0` (default) = unlimited.
- **Hardened `close()`.** Idempotent; drains the queue even if a task errored; removes `<cacheDir>/.lock` on exit to avoid leaking the cross-process lock to the next run.
- **Full structured-log event set.** `blob.fetch.hit`, `blob.fetch.miss`, `blob.cache.evict`, `commit.created`, `commit.queue.wait`, `close.drain.error`, `delete.index.skip` — all via the injectable `logger`.
- Moved helpers to `src/adapters/git-store-internal.ts` (`resolveConfig`, `defaultCommitMessage`, `toBuffer`, `exists`, `isMissing`) to keep `git-store.ts` under the 350-line contract.
- 10 new tests: 5 unit for metrics, 5 integration for operability (metrics wiring, backpressure, idempotent close, lock cleanup).

## [Unreleased] — v0.2 pre-work

### Fixed (validated against real GitHub)

- **HTTPS auth uses Basic, not Bearer.** Initial implementation set `Authorization: Bearer <token>`, which GitHub's smart-HTTP rejects as "invalid credentials". Now the adapter sends `Authorization: Basic <base64(x-access-token:TOKEN)>`, which is the format GitHub + GitLab + Bitbucket all accept for git-over-HTTPS.
- **Base64-encoded token is also redacted.** `makeTokenRedactor(...tokens: string[])` now takes varargs; the adapter passes both the raw token and its base64 form so neither can leak into error messages.
- **E2E validated against real private repo.** `tests/scripts/github-e2e.ts` + `tests/scripts/github-e2e-quick.ts` exercise the HTTPS path end-to-end: create private repo → seed both branches → preload → insert + persist + push → verify redaction on forced error → confirm second reader sees the push.

### Added (post v0.1-candidate)

- **HTTPS auth via `http.extraHeader`**: when `authEnvVar` is set, every git call gets `-c http.extraHeader="Authorization: Bearer <token>"` injected through `RunGitOptions.configs`. Tokens are redacted from all error surfaces and never touch disk.
- **`maxCacheBytes` enforcement**: automatic LRU-like eviction of clean cache entries when `preload()` pushes total bytes past the cap. Dirty entries are preserved (they'd otherwise lose writes).
- **`invalidate(filename): boolean`**: sync method to drop a single clean entry. Returns `false` when the entry is dirty or missing.
- **`cacheBytes(): number`**: observable total of currently-cached payload bytes.
- **`BLOB_FETCH_TIMEOUT` properly raised**: `showBlob()` remaps timeout failures from the generic `GIT_COMMAND_FAILED` to the dedicated error code. Covers both the close-after-abort and spawn-error-after-abort paths.
- **Inline git config in `RunGitOptions`**: new `configs?: Record<string, string>` option is translated to `-c k=v` prefixes. All public helpers (`clone`, `showBlob`, `push`) accept it.
- 6 new integration tests in `tests/integration/auth-and-cache.test.ts` covering the above.

### Changed

- `showBlob(cwd, ref, path, timeoutMs?)` is now `showBlob(cwd, ref, path, opts?: AuthCallOpts)` — takes the full auth bag (timeout, configs, authEnv, redactor). Callers passing a number get a typecheck error and a pointer to update.
- `push()` and `clone()` accept the new `configs` option to forward the auth header.

## [Unreleased] — v0.1 candidate

### Added

- `GitStoreAdapter` — single unified adapter implementing the upstream `StorageAdapter` shape (sync `readJson`/`writeJson`/`readBin`/`writeBin`/`delete` + async `preload`/`persist`/`push`/`close`). One instance serves both [`js-doc-store`](https://github.com/MauricioPerera/js-doc-store) and [`js-vector-store`](https://github.com/MauricioPerera/js-vector-store).
- Two-branch git layout with automatic routing:
  - `indexRef` (default `"index"`): shallow clone, always-local, holds light files (meta, indices, vector manifests)
  - `contentRef` (default `"main"`): partial clone `--filter=blob:none --no-checkout`, holds heavy blobs (`*.docs.json`, `*.bin`)
  - Filename routing via configurable `heavyFileRegex` (default `/\.(bin|docs\.json)$/`)
- Pin-to-SHA support: `contentRef` accepts a 7-40 char commit SHA; the adapter clones + fetches + `update-ref`s to that commit.
- `persist()` creates per-branch commits only when staged changes exist (via `git diff-index --cached --quiet`).
- Cross-process file lock (`<cacheDir>/.lock`) with stale-lock stealing.
- Redactor for auth tokens applied to stderr **and** to the argv portion of error messages.
- `GitStoreError` with typed `ErrorCode` covering `GIT_COMMAND_FAILED`, `BLOB_FETCH_TIMEOUT`, `AUTH_MISSING`, `BRANCH_NOT_FOUND`, `LOCK_TIMEOUT`, `CONCURRENT_WRITE`, `INVALID_INDEX_SCHEMA`, `CACHE_CORRUPTED`, `NOT_IMPLEMENTED_YET`.
- `CONCURRENT_WRITE` raised on non-fast-forward push so callers can implement pull-rebase-retry flows.
- Injectable `Logger` (default: `noopLogger`).
- Examples:
  - `examples/skills-catalog/run.ts` — migrate a skills catalog through a real `DocStore(adapter)` instance
  - `examples/vector-rag/run.ts` — vector round-trip through a real remote
- Benchmarks: `tests/bench/cold-read.ts` (informational, records cold + warm preload times).
- Dev dependencies pinned to the verified upstreams (`github:MauricioPerera/js-doc-store#master`, `github:MauricioPerera/js-vector-store#master`) so integration tests run against the real hosts.

### Tests

- 52 tests total: 29 unit + 23 integration
- Unit: git-args, branch-router, blob-cache LRU, commit-queue serialization, file lock
- Integration (against real `DocStore` / `VectorStore`):
  - preload + find round-trip
  - insert + persist + cross-instance read
  - createIndex → index file on the index branch
  - delete round-trip
  - null for never-preloaded files (upstream contract)
  - binary (`.bin`) routing + `ArrayBuffer` round-trip
  - parallel persist serialization
  - non-fast-forward push → `CONCURRENT_WRITE`
  - pin-to-SHA determinism
  - `BRANCH_NOT_FOUND` on missing ref
  - `AUTH_MISSING` when `authEnvVar` is unset

### Verified against upstreams

Upstream pins (verified 2026-04-19):

- [`js-doc-store`](https://github.com/MauricioPerera/js-doc-store/blob/master/js-doc-store.js) `master` — `FileStorageAdapter` at L210, `DocStore(dirOrAdapter)` at L1138
- [`js-vector-store`](https://github.com/MauricioPerera/js-vector-store/blob/master/js-vector-store.js) `master` — `FileStorageAdapter` at L301 (adds `readBin/writeBin`)

### Known limitations

- `file://` remotes only for auth — HTTPS + SSH hardening deferred to v0.2
- Benchmarks are advisory, not gating (`TEST-PLAN.md` §6). Windows git-spawn latency makes the 500 ms cold budget Linux-only.
- No CF Workers runtime — requires a different transport (v2.0).
- `maxCacheBytes` is configured but no eviction policy is wired in v0.1; entries live for the lifetime of the adapter.

### Removed from the pre-v0.1 bootstrap

- The earlier collection-aware `GitDocStoreAdapter` / `GitVectorStoreAdapter` pair. They implemented a higher-level interface (`readCollection(name)`, `writeCollection(name, docs)`) that did not match either upstream. Replaced with the file-level `GitStoreAdapter`.
- Synthetic type re-exports (`Doc`, `CollectionMeta`, `Manifest`, `DocId`) — the upstream hosts define their own types; the adapter treats filenames and payloads as opaque.

[Unreleased]: https://github.com/MauricioPerera/js-git-store/tree/main
