# API — js-git-store

Public surface. Read ARCHITECTURE.md for internals.

## Exports

```ts
import {
  GitDocStoreAdapter,
  GitVectorStoreAdapter,
  GitStoreError,
  type GitStoreConfig,
  type Logger,
} from "js-git-store";
```

## GitDocStoreAdapter

Intended to be passed to `new DocStore({ adapter: ... })` (js-doc-store constructor signature — check the upstream README for exact shape).

### Constructor

```ts
new GitDocStoreAdapter(config: GitDocStoreConfig)

interface GitDocStoreConfig {
  /** Git URL — https, ssh, or file:// */
  repoUrl: string;

  /** Orphan branch for metadata + indices. Default "index". */
  indexRef?: string;

  /** Content branch for full documents. Default "main". */
  contentRef?: string;

  /**
   * Local cache directory. Worktree for indexRef lives here; content blobs
   * are fetched into a subdirectory on demand.
   */
  localCacheDir: string;

  /**
   * Name of the env var holding the auth token. Adapter reads process.env[name]
   * at construction time AND before each git call (for rotation). Do NOT pass
   * the literal token here.
   */
  authEnvVar?: string;

  /** Default true. When false, caller must call flush() explicitly. */
  autoCommit?: boolean;

  /** Default false. Auto-push is usually wrong; leave the caller in control. */
  pushOnWrite?: boolean;

  /**
   * Called with a list of mutated collection names after each commit.
   * Use it to regenerate indices (index branch files) programmatically.
   * Default: noop (indices NOT auto-regenerated — consider this before relying on indexed queries).
   */
  regenerateIndexHook?: (changedCollections: string[]) => Promise<void>;

  /**
   * Cap for the content blob cache. Oldest-accessed blobs evicted past this.
   * Default 500 MiB.
   */
  maxCacheBytes?: number;

  /** Injectable logger. Default: noop. */
  logger?: Logger;

  /**
   * Timeout for any single git command. Default 30_000 (30 s).
   */
  gitTimeoutMs?: number;
}
```

### Methods (implements js-doc-store StorageAdapter)

Exact method list MUST match the StorageAdapter interface in the upstream js-doc-store. The agent building this project reads the current upstream interface and matches it. Expected surface (subject to upstream changes):

```ts
class GitDocStoreAdapter implements DocStoreAdapter {
  readCollection(name: string): Promise<Doc[]>;
  writeCollection(name: string, docs: Doc[]): Promise<void>;
  readMeta(name: string): Promise<CollectionMeta | null>;
  writeMeta(name: string, meta: CollectionMeta): Promise<void>;
  readIndex(name: string, field: string): Promise<IndexData | null>;
  writeIndex(name: string, field: string, data: IndexData): Promise<void>;
  listCollections(): Promise<string[]>;

  /** Drain in-flight commits. Call before process exit. */
  flush(): Promise<void>;

  /** Push the current HEAD of contentRef to the remote. Only works when configured. */
  push(): Promise<void>;

  /** Stop any background timers and release locks. */
  close(): Promise<void>;
}
```

## GitVectorStoreAdapter

Intended to be passed to `new VectorStore({ adapter: ... })` (js-vector-store constructor signature).

### Constructor

```ts
new GitVectorStoreAdapter(config: GitVectorStoreConfig)

interface GitVectorStoreConfig extends GitDocStoreConfig {
  /**
   * Reranking policy when reading.
   * - "none":              score only fetched cell blobs
   * - "quantized-recall":  use 1-bit quantized recall from index branch + re-rank
   */
  rerankMode?: "none" | "quantized-recall";

  /**
   * Default probes for similarity searches. Caller can override per-query.
   * Default 5.
   */
  defaultProbes?: number;
}
```

### Methods

```ts
class GitVectorStoreAdapter implements VectorStoreAdapter {
  readCollection(name: string): Promise<VectorCollectionBundle>;
  writeCollection(name: string, bundle: VectorCollectionBundle): Promise<void>;
  readIVFCell(name: string, cellId: number): Promise<CellData>;
  listCollections(): Promise<string[]>;
  flush(): Promise<void>;
  push(): Promise<void>;
  close(): Promise<void>;
}
```

## Error class

```ts
class GitStoreError extends Error {
  readonly code: ErrorCode;
  readonly cause?: unknown;  // underlying error if wrapped

  constructor(code: ErrorCode, message: string, cause?: unknown);
}

type ErrorCode =
  | "GIT_COMMAND_FAILED"
  | "BLOB_FETCH_TIMEOUT"
  | "AUTH_MISSING"
  | "BRANCH_NOT_FOUND"
  | "LOCK_TIMEOUT"
  | "CONCURRENT_WRITE"
  | "INVALID_INDEX_SCHEMA"
  | "CACHE_CORRUPTED";
```

## Logger interface

```ts
interface Logger {
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}
```

Default (exported constant): `noopLogger`. Plug pino, console, or custom.

## Usage examples

### Doc adapter — knowledge base

```ts
import { DocStore } from "js-doc-store";
import { GitDocStoreAdapter } from "js-git-store";

const adapter = new GitDocStoreAdapter({
  repoUrl: "https://github.com/me/my-knowledge-base.git",
  authEnvVar: "GITHUB_TOKEN",
  localCacheDir: "./.cache/kb",
  autoCommit: true,
  pushOnWrite: false,
});

const db = new DocStore({ adapter });

await db.collection("articles").insert({ title: "Hello", body: "..." });
await db.collection("articles").insert({ title: "World", body: "..." });

// All writes above are committed to local HEAD. Nothing pushed yet.
await adapter.flush();  // safe to exit process

// Later, when ready:
await adapter.push();   // now the remote has them
```

### Vector adapter — versioned RAG

```ts
import { VectorStore } from "js-vector-store";
import { GitVectorStoreAdapter } from "js-git-store";

const adapter = new GitVectorStoreAdapter({
  repoUrl: "https://github.com/me/rag-index.git",
  contentRef: "embeddings-v2",  // experiment branch with new model
  localCacheDir: "./.cache/rag",
  rerankMode: "quantized-recall",
  defaultProbes: 5,
  authEnvVar: "GITHUB_TOKEN",
});

const vectors = new VectorStore({ adapter });

const results = await vectors
  .collection("articles")
  .similaritySearch(queryEmbedding, { topK: 10 });

// queryEmbedding is Float32Array[768]; results hydrated from ~5 IVF cells
// total blobs fetched: < 10 MB for a 1M-vector corpus
```

### Pinning to a specific commit for reproducibility

```ts
const adapter = new GitDocStoreAdapter({
  repoUrl: "...",
  contentRef: "3d654f6",  // specific commit SHA, not a branch
  localCacheDir: "...",
});

// This DB is frozen as of 3d654f6. Perfect for reproducible RAG or audit.
```

## Compatibility notes

- The adapter implements whatever StorageAdapter surface js-doc-store and js-vector-store expose at the pinned version (see CONTRACT.md section 4 for pins).
- If upstream adds methods, the adapter returns `Promise.reject(new GitStoreError("NOT_IMPLEMENTED_YET", ...))` — never silently noop.
- Node 20+ only. Node 18 and below lack the async disposable patterns the cleanup relies on.
