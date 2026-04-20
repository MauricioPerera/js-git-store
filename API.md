# API — js-git-store

Public surface. Read ARCHITECTURE.md for internals.

## Exports

```ts
import {
  GitStoreAdapter,
  GitStoreError,
  noopLogger,
  type GitStoreConfig,
  type Logger,
  type ErrorCode,
} from "js-git-store";
```

## GitStoreAdapter

Unified adapter. Same instance works with `js-doc-store` and `js-vector-store`:

```ts
import { DocStore } from "js-doc-store";
import { GitStoreAdapter } from "js-git-store";

const adapter = new GitStoreAdapter({
  repoUrl: "https://github.com/me/my-kb.git",
  localCacheDir: "./.cache/kb",
  authEnvVar: "GITHUB_TOKEN",
});

const db = new DocStore(adapter);   // positional, matches upstream
```

### Constructor

```ts
new GitStoreAdapter(config: GitStoreConfig)

interface GitStoreConfig {
  /** Git URL — https, ssh, or file://. Required. */
  repoUrl: string;

  /** Local cache directory. Worktrees + content blob cache live here. Required. */
  localCacheDir: string;

  /** Orphan light-files branch. Shallow clone, always local. Default "index". */
  indexRef?: string;

  /** Heavy-files branch. Partial clone (--filter=blob:none), fetched on demand. Default "main". */
  contentRef?: string;

  /**
   * Routes a filename to the heavy branch if it matches, to the index branch otherwise.
   * Default matches js-doc-store + js-vector-store heavy blobs:
   *   /\.(bin|docs\.json)$/
   */
  heavyFileRegex?: RegExp;

  /**
   * Env var name holding the auth token. The adapter reads process.env[name] at each
   * git call (for rotation). Token is never logged, never stored on disk, and is
   * redacted from error messages.
   */
  authEnvVar?: string;

  /** Auto-push on every persist(). Default false — most callers push explicitly. */
  pushOnPersist?: boolean;

  /** Injectable logger. Default: noopLogger. */
  logger?: Logger;

  /** Timeout for any single git command. Default 30_000. */
  gitTimeoutMs?: number;

  /** Cross-process lock acquisition timeout. Default 30_000. */
  lockTimeoutMs?: number;

  /** Lock older than this is considered stale and reclaimable. Default 60_000. */
  staleLockMs?: number;

  /** Identity used for commits the adapter creates. */
  author?: { name: string; email: string };

  /** Commit message builder. Default: `js-git-store: persist N file(s)`. */
  commitMessage?: (changedFiles: string[]) => string;

  /** Cap for the in-memory blob cache. LRU eviction of clean entries past this. Default 500 MiB. */
  maxCacheBytes?: number;

  /** Clone depth for the index branch. `0` or negative = full history. Default `1` (shallow). */
  indexDepth?: number;

  /**
   * If > 0, run `git gc --auto` on both worktrees every N ms in the background.
   * Cleared on close(). Default 0 (off). Caller can still invoke `gc()` manually.
   */
  gcIntervalMs?: number;
}
```

### Methods — sync (served from in-memory cache)

The sync surface matches the upstream `FileStorageAdapter` interface exactly.

```ts
class GitStoreAdapter {
  /** Returns parsed JSON from cache, or null if not preloaded / not written yet. */
  readJson<T = unknown>(filename: string): T | null;

  /** Stages JSON in cache as dirty. Does NOT touch git until persist() is called. */
  writeJson(filename: string, data: unknown): void;

  /** Returns the raw blob from cache as an isolated copy (safe to retain). Null if not preloaded. */
  readBin(filename: string): ArrayBuffer | null;

  /**
   * Zero-copy view over the cached bytes. Returned Uint8Array shares memory
   * with the cache. MUST NOT mutate. MUST NOT retain past the next persist() /
   * invalidate() / refresh() / close(). Null if not preloaded.
   */
  readBinShared(filename: string): Uint8Array | null;

  /** Stages a binary payload in cache as dirty. */
  writeBin(filename: string, buffer: ArrayBuffer | Uint8Array): void;

  /** Marks the file for deletion on next persist(). */
  delete(filename: string): void;
}
```

Rules:

- `readJson`/`readBin` return `null` for files that were never written and were not in the preload list. This matches the upstream contract.
- `writeJson`/`writeBin` are fire-and-forget into cache; durability is reached only via `persist()`.
- Cache entries written in this process are visible to subsequent reads in the same process immediately.

### Methods — async (git I/O)

```ts
class GitStoreAdapter {
  /**
   * Clone both refs locally on first call, then hydrate the in-memory cache with the
   * listed filenames. Heavy files are fetched from the content branch (partial clone
   * triggers a git fetch per blob on access); light files are read from the shallow
   * index worktree.
   *
   * Calling with filenames that don't exist in the repo is allowed — those reads
   * later return null.
   */
  preload(filenames: string[]): Promise<void>;

  /**
   * Write all dirty cache entries to their target worktree, stage, commit per branch,
   * and (if pushOnPersist) push. Deletions are applied as git rm.
   *
   * Safe to call with no dirty entries — becomes a no-op.
   * Serialized in-process; cross-process via a file lock under localCacheDir.
   */
  persist(): Promise<void>;

  /** Push current HEAD of both branches to origin. No-op if already up to date. */
  push(): Promise<void>;

  /**
   * Pull latest refs from origin and drop all clean cache entries so subsequent
   * reads see the new state. Dirty entries are preserved.
   *
   * Throws `CONCURRENT_WRITE` if local un-pushed commits exist on either
   * branch (calling `refresh()` would discard them). Pass `{ force: true }` to
   * override and accept the discard.
   *
   * Serialized via commit queue + flock.
   */
  refresh(opts?: { force?: boolean }): Promise<void>;

  /**
   * Run `git gc --auto --quiet` on both worktrees to repack loose objects and
   * reclaim disk. Serialized via queue + flock. Safe on a live repo.
   */
  gc(): Promise<void>;

  /** Drain pending work and release locks. Call before process exit. */
  close(): Promise<void>;

  /** `await using` support — equivalent to `await close()`. Needs Node 20+ / TS 5.2+. */
  [Symbol.asyncDispose](): Promise<void>;
}
```

### `await using` pattern

```ts
{
  await using adapter = new GitStoreAdapter({ ... });
  await adapter.preload([...]);
  // ... work ...
}  // adapter.close() is called automatically here, even on thrown errors
```

### Methods — cache management (sync)

```ts
class GitStoreAdapter {
  /**
   * Drop a single clean entry from the in-memory cache. Returns false if the entry
   * is missing or still dirty (dirty entries are never evicted — you'd lose writes).
   * A later preload() of the same filename re-fetches from git.
   */
  invalidate(filename: string): boolean;

  /** Current cached bytes (sum of payload sizes across all entries). */
  cacheBytes(): number;

  /** Number of entries currently in the in-memory cache (including tombstones). */
  cacheEntryCount(): number;
}
```

Automatic eviction: when `preload()` loads a new file that pushes total bytes past `maxCacheBytes`, the oldest CLEAN entries are dropped in insertion order. Dirty entries always stay resident until `persist()` runs.

## Authentication — HTTPS

When `authEnvVar` is configured, every git invocation gets:

- `GIT_TERMINAL_PROMPT=0` — no interactive prompts
- An injected `Authorization: Bearer <token>` header via `-c http.extraHeader=...`
- Stderr redaction replacing the token with `***`

For GitHub, a fine-grained PAT or a GitHub App installation token in `GITHUB_TOKEN` is the expected setup:

```ts
const adapter = new GitStoreAdapter({
  repoUrl: "https://github.com/me/private-kb.git",
  authEnvVar: "GITHUB_TOKEN",
  localCacheDir: "./.cache",
});
```

The token is never written to disk, never logged, and redacted from any error surfaced to the caller.

## Authentication — SSH

No special configuration. The adapter inherits your system's `ssh` / `~/.ssh/config`. Point `repoUrl` at `git@github.com:me/repo.git` and git does the rest.

## Metrics + structured logging (v0.3)

Inject a `MetricsCollector` to observe adapter internals without parsing logs. Default is noop. Use `InMemoryMetrics` for tests or scrape targets.

```ts
import { GitStoreAdapter, InMemoryMetrics } from "js-git-store";

const metrics = new InMemoryMetrics();
const adapter = new GitStoreAdapter({ ..., metrics });

await adapter.preload(["users.docs.json", "users.meta.json"]);
metrics.snapshot();
// [
//   { name: "gitstore.blob.fetch", kind: "counter", value: 2, labels: { branch: "...", result: "ok" } },
//   { name: "gitstore.blob.fetch.ms", kind: "histogram", value: 12, count: 2, ... },
// ]
```

Emitted metrics:

| Name | Kind | Labels | When |
|---|---|---|---|
| `gitstore.blob.fetch` | counter | `branch`, `result: ok \| miss \| error` | Every preload attempt |
| `gitstore.blob.fetch.ms` | histogram | `branch` | On successful fetch |
| `gitstore.commit` | counter | `branch` | On every commit created by persist() |
| `gitstore.cache.evict` | counter | — | On every cache entry evicted past `maxCacheBytes` |
| `gitstore.queue.wait.ms` | histogram | — | Time each write spent in the commit queue |
| `gitstore.persist.backpressure` | counter | — | Every rejected `persist()` call |
| `gitstore.refresh` | counter | — | Every completed `refresh()` call |
| `gitstore.gc` | counter | — | Every completed `gc()` call |
| `gitstore.gc.ms` | histogram | — | `gc()` duration |

Structured events via `logger`: `blob.fetch.hit`, `blob.fetch.miss`, `blob.cache.evict`, `commit.created`, `commit.queue.wait`, `close.drain.error`, `delete.index.skip`.

## Backpressure

Set `maxPendingWrites > 0` to cap the in-flight commit queue. `persist()` rejects with `BACKPRESSURE` when the queue is full. Callers typically retry after a short delay or reduce write concurrency.

## Error class

```ts
class GitStoreError extends Error {
  readonly code: ErrorCode;
  readonly cause?: unknown;
  constructor(code: ErrorCode, message: string, cause?: unknown);
}

type ErrorCode =
  | "GIT_COMMAND_FAILED"
  | "BLOB_FETCH_TIMEOUT"
  | "AUTH_MISSING"
  | "BRANCH_NOT_FOUND"
  | "LOCK_TIMEOUT"
  | "CONCURRENT_WRITE"
  | "BACKPRESSURE"
  | "ADAPTER_CLOSED"
  | "INVALID_CONFIG"
  | "INVALID_INDEX_SCHEMA"
  | "CACHE_CORRUPTED"
  | "NOT_IMPLEMENTED_YET";
```

## Logger

```ts
interface Logger {
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}
```

## Usage examples

### Doc store — versioned knowledge base

```ts
import { DocStore } from "js-doc-store";
import { GitStoreAdapter } from "js-git-store";

const adapter = new GitStoreAdapter({
  repoUrl: "https://github.com/me/my-kb.git",
  localCacheDir: "./.cache/kb",
  authEnvVar: "GITHUB_TOKEN",
});

const db = new DocStore(adapter);

// Hydrate the files the next operations will touch.
await adapter.preload(["articles.docs.json", "articles.meta.json"]);

const articles = db.collection("articles");
articles.createIndex("slug", { unique: true });
articles.insert({ slug: "hello-world", title: "Hello", body: "..." });

// Persist to git (commits; doesn't push yet).
db.flush();             // flushes the host-level cache
await adapter.persist(); // commits changed files
await adapter.push();    // publish when ready
```

### Vector store — git-backed RAG

```ts
import { VectorStore } from "js-vector-store";
import { GitStoreAdapter } from "js-git-store";

const adapter = new GitStoreAdapter({
  repoUrl: "https://github.com/me/rag-index.git",
  contentRef: "embeddings-v2",
  localCacheDir: "./.cache/rag",
  authEnvVar: "GITHUB_TOKEN",
});

await adapter.preload(["articles.bin", "articles.json"]);

const store = new VectorStore(adapter, 768);
const hits = store.search("articles", queryEmbedding, 10);
```

### Pinning to a commit for reproducibility

```ts
const adapter = new GitStoreAdapter({
  repoUrl: "...",
  contentRef: "3d654f6",
  localCacheDir: "...",
});
```

Both refs can be branches, tags, or full SHAs.

## Compatibility

- The adapter matches the real `FileStorageAdapter` shape as of the upstream repos' `master` branch on 2026-04-19. If upstream changes, pin or fork.
- Node 20+ only.
- Windows: works via native git (partial clone requires git 2.22+). File paths are normalized internally.
