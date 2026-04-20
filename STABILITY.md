# STABILITY — js-git-store

Stability guarantees for v1.0 and above.

## SemVer commitment

Starting with v1.0:

- **Major bump** required for: removing or renaming any exported symbol; removing or renaming any `GitStoreConfig` field; removing any `ErrorCode`; changing observable behaviour of a public method in a way that breaks existing callers; renaming any emitted metric; removing any emitted structured-logger event.
- **Minor bump** required for: adding a new optional `GitStoreConfig` field; adding a new `ErrorCode`; adding a new public method; adding a new emitted metric or event; adding an overload.
- **Patch bump** for: bug fixes with no API change, performance improvements, internal refactors, doc updates.

## Frozen public API

The following are the complete public surface as of v1.0:

### Exports from `js-git-store`

```ts
// Classes
GitStoreAdapter
GitStoreError
InMemoryMetrics

// Constants
DEFAULT_HEAVY_REGEX
noopLogger
noopMetrics

// Types
GitStoreConfig
ErrorCode
Logger
Counter
Histogram
MetricSample
MetricsCollector
```

Anything not listed here is internal — even if TypeScript lets you import it.

### `GitStoreConfig` fields (frozen)

```ts
repoUrl          string              required
localCacheDir    string              required
indexRef         string              optional, default "index"
contentRef       string              optional, default "main"
heavyFileRegex   RegExp              optional, default /\.(bin|docs\.json)$/
authEnvVar       string              optional
pushOnPersist    boolean             optional, default false
logger           Logger              optional, default noopLogger
metrics          MetricsCollector    optional, default noopMetrics
gitTimeoutMs     number              optional, default 30_000
lockTimeoutMs    number              optional, default 30_000
staleLockMs      number              optional, default 60_000
author           { name, email }     optional
commitMessage    (files: string[]) => string   optional
maxCacheBytes    number              optional, default 524_288_000 (500 MiB)
maxPendingWrites number              optional, default 0 (unlimited)
indexDepth       number              optional, default 1 (0 = full)
gcIntervalMs     number              optional, default 0 (off)
```

### `GitStoreAdapter` methods (frozen)

```ts
// Sync, served from in-memory cache
readJson<T>(filename):       T | null
readBin(filename):           ArrayBuffer | null   // copy, safe to retain
readBinShared(filename):     Uint8Array | null    // zero-copy view, see docstring
writeJson(filename, data):   void
writeBin(filename, buffer):  void
delete(filename):            void
invalidate(filename):        boolean
cacheBytes():                number
cacheEntryCount():           number

// Async, git I/O
preload(filenames):                 Promise<void>
persist():                          Promise<void>
push():                             Promise<void>
refresh({ force? }):                Promise<void>
gc():                               Promise<void>
close():                            Promise<void>
[Symbol.asyncDispose]():            Promise<void>
```

### `ErrorCode` values (frozen)

```
GIT_COMMAND_FAILED
BLOB_FETCH_TIMEOUT
AUTH_MISSING
BRANCH_NOT_FOUND
LOCK_TIMEOUT
CONCURRENT_WRITE
BACKPRESSURE
ADAPTER_CLOSED
INVALID_CONFIG          (also raised on path-traversal in filenames)
INVALID_INDEX_SCHEMA
CACHE_CORRUPTED
NOT_IMPLEMENTED_YET
```

Additions require a minor bump. Removals require a major bump.

### Metric names (frozen)

```
gitstore.blob.fetch             counter    labels: { branch, result }
gitstore.blob.fetch.ms          histogram  labels: { branch }
gitstore.commit                 counter    labels: { branch }
gitstore.cache.evict            counter
gitstore.queue.wait.ms          histogram
gitstore.persist                counter
gitstore.persist.ms             histogram
gitstore.persist.backpressure   counter
gitstore.refresh                counter
gitstore.gc                     counter
gitstore.gc.ms                  histogram
```

### Structured logger event names (frozen)

```
blob.fetch.hit
blob.fetch.miss
blob.cache.evict
commit.created
commit.queue.wait
refresh
gc.completed
gc.background.error
close.drain.error
delete.index.skip
```

## Deprecation policy

A feature marked deprecated in version `X.Y.0` is removed no earlier than `(X+1).0.0`, i.e., at the next major bump. Runtime deprecations emit a `logger.warn(...)` event named `deprecated.<feature>` at every call site.

## Repo-layout stability

The `tree-first / blob-on-demand` two-branch layout (`indexRef` = light, `contentRef` = heavy, routed by `heavyFileRegex`) is frozen. The adapter does not migrate between layouts silently; layout changes require a new major.

## Node version commitment

- v1.0.x: Node 20 LTS minimum. Node 22 LTS and 24 LTS are tested in CI.
- Node 18 is explicitly unsupported (no `Symbol.asyncDispose`, partial-clone edge cases).

## Non-freeze list

Explicitly NOT covered by v1.0 stability:

- The private classes `CacheLayer` and `GitLayer` in `src/core/` — internal. Import paths like `js-git-store/core/cache-layer.js` are unsupported.
- The exact wording of error messages (only the `code` is stable).
- The exact format of commit messages produced by `defaultCommitMessage` (override via `commitMessage` if you need stability there).
- Benchmark numbers in `tests/bench/`.
- The E2E test scripts in `tests/scripts/`.

## Migration from v0.x to v1.0

v1.0 does not introduce any breaking changes versus the last v0.6 `Unreleased` state. If you were importing from:

- `GitStoreAdapter`, `GitStoreConfig`, `GitStoreError`, `ErrorCode`, `Logger`, `noopLogger`, `DEFAULT_HEAVY_REGEX`, `InMemoryMetrics`, `noopMetrics`, `Counter`, `Histogram`, `MetricSample`, `MetricsCollector` — no action needed.

If you reached into internals (e.g., `cache-layer.ts`, `git-layer.ts`, `git-store-internal.ts`) — you need to switch to the public API. Open an issue if a genuine missing hook is motivating the reach-in.
