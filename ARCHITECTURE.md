# ARCHITECTURE — js-git-store

Detail of the modules, their responsibilities, and how data flows. Read AFTER CONTRACT.md and SPECIFICATION.md.

## Module layout

```
src/
├── index.ts                         Barrel export (GitStoreAdapter, metrics, types)
├── core/
│   ├── git.ts                       Thin child_process wrapper for git commands
│   ├── cache-layer.ts               In-memory cache: LRU touch, byte accounting, dirty/tombstone
│   ├── git-layer.ts                 Git orchestration: clones, flock, queue, commit/push/refresh/gc
│   ├── branch-router.ts             Heavy/light routing by filename regex
│   ├── commit-queue.ts              InProcessCommitQueue + FileLock primitives
│   ├── atomic-write.ts              tmp + fsync + rename helper
│   └── types.ts                     Shared types + GitStoreError
├── adapters/
│   ├── git-store.ts                 GitStoreAdapter — thin StorageAdapter composition
│   └── git-store-internal.ts        resolveConfig, defaultCommitMessage, helpers
├── metrics.ts                       Injectable metrics (noop + InMemoryMetrics)
└── logger.ts                        Injectable noop-default logger

tests/
├── unit/                            Pure-function tests (no git invocation)
│   ├── git-args.test.ts             Verify git command argument construction
│   ├── index-branch.test.ts         Verify index layout calculations
│   ├── blob-cache.test.ts           LRU eviction semantics
│   └── commit-queue.test.ts         Serialization contract
├── integration/                     Real git ops against local bare repos
│   ├── doc-adapter.test.ts          End-to-end against js-doc-store suite
│   ├── vector-adapter.test.ts       End-to-end against js-vector-store suite
│   └── concurrency.test.ts          Cross-process flock behavior
└── fixtures/
    ├── make-bare-repo.sh            Spin up a local file:// remote
    └── sample-corpora/              Small test datasets

examples/
├── skills-catalog/                  Migrate a2e-skills to use the doc adapter
└── vector-rag/                      Build a versioned RAG index + query it
```

## Request lifecycle — doc adapter read path

```
js-doc-store.find({email: "x@y"})
  └── adapter.readCollection("users")
      ├── check local cache at <cacheDir>/collections/users.docs.jsonl
      │   ├── present + fresh → read from disk, return
      │   └── absent or stale → continue
      ├── blobFetch.fetch("collections/users.docs.jsonl")
      │   ├── git fetch <contentRef>:collections/users.docs.jsonl
      │   ├── write to cache atomically (tmp + fsync + rename)
      │   └── evict LRU if cache size exceeded
      └── parse JSONL, return
```

Index-aware reads (using the index branch):

```
js-doc-store.find({email: "x@y"}, {useIndex: "email"})
  └── adapter.readIndex("users", "email")
      ├── cache hit (index branch is small, always locally cloned) → return index
      └── apply index lookup, pulls only matching doc offsets from content
```

## Request lifecycle — doc adapter write path

```
js-doc-store.insert("users", {email: "x@y", name: "X"})
  └── adapter.writeCollection("users", [...existing, newDoc])
      └── commitQueue.enqueue(async () => {
            ├── atomicWrite cache <cacheDir>/collections/users.docs.jsonl
            ├── stage the file in the repo working tree
            ├── if regenerateIndexHook: call it → updates index branch files
            ├── git commit with message "insert users/<id>"
            └── if pushOnWrite: git push
          })
```

## Request lifecycle — vector adapter similarity search

```
js-vector-store.similaritySearch("embeddings", queryVec, topK=10, probes=5)
  └── adapter.readCollection("embeddings")
      ├── read centroids.bin (local, from index branch)
      ├── compute topProbes cells against query vector
      ├── for each cell:
      │     blobFetch.fetch("vectors/embeddings/cell-XXXX.vec.bin")
      ├── score vectors within fetched cells
      └── return top-K
```

If quantized recall vectors are in the index branch:

```
similaritySearch(..., {useQuantizedRecall: true, recallK: 100})
  ├── read embeddings.quantized.bin (local)
  ├── score all ~1M vectors with Hamming distance (fast, no fetch)
  ├── take top-100 candidates
  ├── identify which cells they belong to (~1-10 cells typical)
  ├── fetch only those cells
  └── re-rank top-100 with full-precision cosine
```

This is the key architectural insight: **local-and-fast for recall, remote-and-accurate for precision**.

## Core module contracts

### `core/git.ts`

```ts
interface RunGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

// All git invocations go through this. Never `shell: true`. Always argv-array.
export function runGit(
  args: readonly string[],
  opts: {
    cwd: string;
    timeoutMs?: number;
    authEnv?: Record<string, string>;  // appended to process.env for this call only
    input?: string;                     // stdin
    redactor?: (text: string) => string; // for error messages
  }
): Promise<RunGitResult>;

export function cloneShallow(remote: string, dir: string, ref: string, opts: {...}): Promise<void>;
export function fetchBlob(cwd: string, ref: string, path: string): Promise<void>;
export function commitAll(cwd: string, message: string, opts: {...}): Promise<string>; // returns SHA
export function push(cwd: string, remote: string, ref: string): Promise<void>;
```

### `core/blob-fetch.ts`

```ts
interface BlobCache {
  get(path: string): Promise<Buffer | null>;  // null = cache miss, must fetch
  put(path: string, data: Buffer): Promise<void>;
  size(): Promise<number>;  // bytes
  sweep(targetBytes: number): Promise<number>; // returns bytes freed
}

interface BlobFetcher {
  fetch(path: string): Promise<Buffer>;  // try cache, then git fetch, then return
  invalidate(path: string): Promise<void>;
}
```

### `core/commit-queue.ts`

```ts
interface CommitQueue {
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;  // waits for empty
  size(): number;
}
```

Cross-process coordination: a `.commit-queue.lock` file in the repo root, managed via `open(path, 'wx')`. Stale-lock detection: if the lock is older than configurable timeout (default 60s), force-steal.

## Error model

The adapter defines its own error class hierarchy:

```ts
class GitStoreError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string);
}

type ErrorCode =
  | "GIT_COMMAND_FAILED"      // wraps a non-zero git exit
  | "BLOB_FETCH_TIMEOUT"
  | "AUTH_MISSING"             // authEnvVar was set but env var is unset/empty
  | "BRANCH_NOT_FOUND"
  | "LOCK_TIMEOUT"
  | "CONCURRENT_WRITE"         // optimistic push rejected (non-fast-forward)
  | "INVALID_INDEX_SCHEMA"     // index branch has wrong layout
  | "CACHE_CORRUPTED"          // local cache checksum mismatch (if enabled)
```

Host library errors propagate unchanged — this adapter only raises on git-specific failures.

## Caching strategy

On-disk cache layout:

```
<localCacheDir>/
├── .lock                         Cross-process write lock
├── .meta.json                    Cache version, creation time, repo URL hash
├── index-worktree/               Shallow clone of indexRef
└── content-cache/
    ├── collections/
    │   └── users.docs.jsonl
    └── vectors/
        └── embeddings/
            ├── cell-0001.vec.bin
            └── ...
```

- `index-worktree/` is a normal git worktree. Pull via `git pull --ff-only` to refresh.
- `content-cache/` is NOT a git worktree. Blobs are fetched via `git fetch --no-write-fetch-head origin <ref>:<path>` then materialized with `git cat-file blob`, written atomically.
- LRU eviction sweeps `content-cache/` when total size exceeds configurable cap.

## Authentication

- HTTPS with token: `authEnvVar: "GITHUB_TOKEN"`. The adapter reads the env var and sets `GIT_ASKPASS` or equivalent before git calls. **Never log the token. Never include it in thrown errors.**
- SSH: inherit from the host's SSH config. `authEnvVar` not used.
- Public repos: `authEnvVar` not set. HTTPS clone works unauthenticated.

The redactor in `core/git.ts` ensures any stderr text that echoes the token is redacted before surfacing to the caller. Follow the pattern from `a2e-shell/src/credentials/redactor.ts`.

## Observability

The logger is injectable:

```ts
interface Logger {
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}
```

Default: noop. The caller can plug in pino or console. Events emitted by the adapter (minimum viable set):

- `git.command` (args, durationMs, exitCode)
- `blob.fetch.miss` (path)
- `blob.fetch.hit` (path)
- `blob.cache.evict` (bytesFreed, items)
- `commit.created` (sha, message, filesChanged)
- `commit.queue.wait` (waitedMs)

## What NOT to do

- Do not use `git pull` — use `git fetch` + explicit merge/reset. `git pull` hides errors.
- Do not use `shell: true` on spawn. Argv arrays only.
- Do not parse `git log` output — use `git log --format=%H%x00%s%x00%at` and split on NUL.
- Do not assume `main` is the default branch. Read it from `refs/remotes/origin/HEAD` if needed.
- Do not keep git processes alive between calls. Spawn per command, let GC handle cleanup.
- Do not store auth tokens in files inside the cache dir, even encrypted.
