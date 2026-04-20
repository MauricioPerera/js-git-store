# SPECIFICATION — js-git-store

Detailed technical specification. The agent should read this before writing code to understand the *why* behind decisions encoded in CONTRACT.md.

## 1. What this project is

`js-git-store` provides a single pluggable storage adapter that lets [`js-doc-store`](https://github.com/MauricioPerera/js-doc-store) and [`js-vector-store`](https://github.com/MauricioPerera/js-vector-store) persist their data in a git repository — with the specific layout "tree first, blob on demand". The result is a knowledge-base substrate that is:

- **Content-addressable**: every version of every file is a git SHA
- **Versioned by construction**: git log = full audit trail
- **Distributed by default**: clone = replica; pull = sync
- **Branch-oriented**: branches = dev/staging/prod or experiment variants
- **Edge-deployable (eventually)**: reads only need partial clone of the index branch + blob fetches; writes need a pushable remote

## 2. What problem it solves

Existing document and vector stores in JS land are:

- **Ephemeral** (in-memory) — no versioning, no audit
- **Filesystem-only** (`FileStorageAdapter`) — versioning = manual snapshots, no branching, no signatures
- **KV-backed** (`CloudflareKVAdapter`) — no history, no branches, not portable

This project fills the gap: **git-native storage for structured JS data**, usable for knowledge bases, config stores, versioned RAG, any read-heavy domain where history matters.

## 3. The real StorageAdapter contract (verified 2026-04-19)

The upstream adapter interface is **sync read/write + async preload/persist** (same shape as the existing `VercelBlobAdapter` and `CloudflareKVAdapter`):

```ts
interface StorageAdapter {
  readJson(filename: string): unknown | null;       // sync, from cache
  writeJson(filename: string, data: unknown): void; // sync, into cache
  readBin?(filename: string): ArrayBuffer | null;   // sync, from cache (vector)
  writeBin?(filename: string, buf: ArrayBuffer | Uint8Array): void;
  delete(filename: string): void;

  preload?(filenames: string[]): Promise<void>;     // hydrate cache from remote
  persist?(): Promise<void>;                         // flush dirty cache to remote
}
```

Host libraries pick filenames following known shapes:

- DocStore: `<col>.docs.json`, `<col>.meta.json`, `<col>.<field>.idx.json`, `<col>.<field>.sidx.json`
- VectorStore: `<col>.bin|q8.bin|b1.bin`, `<col>.json|q8.json|b1.json`

The adapter treats filenames as opaque — it never parses or reconstructs them.

## 4. The "tree first, blob on demand" pattern

The adapter uses **two git refs** for different file-weight classes.

### `index` branch (orphan — light files, shallow clone)

Always-local, always-fresh. Holds the "light" files that hosts need on every operation:

- `<col>.meta.json`
- `<col>.<field>.idx.json` / `.sidx.json`
- `<col>.json` / `<col>.q8.json` / `<col>.b1.json`

Clients clone this branch `--depth=1 --single-branch`. Typical size < 100 MB.

### `main` content branch (heavy files, partial clone)

Holds the bulk of the data:

- `<col>.docs.json` (can be tens of MB per collection)
- `<col>.bin` / `<col>.q8.bin` / `<col>.b1.bin` (vector blobs, can be GB)

Clients clone with `--filter=blob:none --no-checkout`. Git fetches blobs lazily when `git show HEAD:<path>` is invoked. The adapter caches those blobs in memory under `localCacheDir`, bounded by `maxCacheBytes` (LRU eviction).

### Routing

The `heavyFileRegex` config decides which branch a filename lives on. Default: `/\.(bin|docs\.json)$/`. Callers can override for custom schemas.

### Lifecycle example — DocStore query

1. Caller runs `await adapter.preload(["users.docs.json", "users.meta.json"])`
2. `users.meta.json` matches the index regex → read from the shallow index worktree (always local)
3. `users.docs.json` matches heavy regex → `git show HEAD:users.docs.json` in the content clone triggers a partial-clone blob fetch; the resulting buffer goes into the in-memory cache
4. `new DocStore(adapter).collection("users").find(...)` runs; it calls the sync `readJson("users.docs.json")` which returns the cached array
5. An insert triggers `writeJson("users.docs.json", [...updated])` — cache entry marked dirty
6. `adapter.persist()` writes the dirty file to the content worktree, `git add` + `git commit` on contentRef. Meta/index updates (if any) commit on indexRef.
7. Optional `adapter.push()` or `pushOnPersist: true`

## 5. Architectural invariants

### Sync reads/writes never touch git

This is the whole point of the sync-cache pattern. Reads return null for unloaded files; callers are expected to `preload` first. Writes stage in memory; durability is only reached through `persist()`.

### Persist is serialized

In-process: a single commit queue. Cross-process: a file lock at `<cacheDir>/.lock`, stolen if stale past `staleLockMs`.

### Reads never hit the remote unless missing locally

Local cache is authoritative. `preload` triggers git fetches only on cache miss. Successful fetches are cached in memory (and the git object DB, via partial clone).

### Push is explicit unless `pushOnPersist` is true

Most callers do many ops then one push. `pushOnPersist: true` is a convenience for auto-sync setups.

### Content branch uses partial clone; index does not

Partial clone (`--filter=blob:none`) requires the remote to allow it. file://, GitHub, GitLab all do. For niche remotes that don't, the adapter surfaces a clear error.

## 6. Scale ceiling (honest)

### Reads

- Index branch: practical ceiling ~100 MB of light files. Past that, the shallow clone slows down.
- Blob fetch latency: ~10-100 ms per heavy file on first access (network RTT dominated). Fine for offline-preload-heavy workflows, bad for > 10 qps real-time.

### Writes

- Per-commit overhead: ~50-200 ms (spawn git + hash + commit). Persisting a batch of 100 changed files = one commit per branch = ~400 ms typical.
- Cross-process contention: serialized via flock. A hot repo with 10 writers will queue up.

### What you SHOULDN'T build with this

- Live sessions / cart data (write-heavy, latency-sensitive)
- Logs, metrics, telemetry
- Multi-tenant shared state (one repo per tenant doesn't scale)
- Real-time collaborative editing
- Billion-scale vector search

### What you SHOULD build with this

- Agent knowledge bases (skills, docs, prompts)
- Config / feature-flag stores with review workflow
- Versioned RAG indices pinned to embedding model version
- Scientific dataset archives with experiment branches
- Content catalogs where PR = editorial workflow

## 7. Integration with the broader a2e ecosystem

This project was conceived during work on [a2e-shell](https://github.com/MauricioPerera/a2e-shell) and [a2e-skills](https://github.com/MauricioPerera/a2e-skills). a2e-skills today uses CI-regenerated index branch + manual file writes. Migration to `js-git-store` replaces `tools/gen-index.ts` + `tools/push-index.sh` with programmatic writes through the adapter.

The example in `examples/skills-catalog/` demonstrates the migration using a real `DocStore` instance pointed at the adapter.

## 8. Explicit non-goals

- Do not build a web UI. This is a library.
- Do not build a REST/HTTP server. That's the caller's job.
- Do not implement replication between multiple git hosts. Git's built-in remotes are enough.
- Do not implement transactions across repos. One repo = one "database".
- Do not compete on SQL/query richness. Inherit whatever the host library provides.
- Do not deduplicate across collections.

## 9. What to cross-reference before writing code

1. [`js-doc-store/js-doc-store.js`](https://github.com/MauricioPerera/js-doc-store/blob/master/js-doc-store.js) — `FileStorageAdapter` at L210, `Collection._ensureLoaded` at L754, `DocStore(dirOrAdapter)` at L1138
2. [`js-vector-store/js-vector-store.js`](https://github.com/MauricioPerera/js-vector-store/blob/master/js-vector-store.js) — `FileStorageAdapter` at L301 (adds `readBin/writeBin`)
3. [`js-doc-store/vercel-blob-adapter.js`](https://github.com/MauricioPerera/js-doc-store/blob/master/vercel-blob-adapter.js) — canonical sync-cache + async-persist pattern
4. [a2e-shell/src/catalog/cache.ts](https://github.com/MauricioPerera/a2e-shell) — shallow clone + partial fetch + flock reference
5. [a2e-skills/tools/gen-index.ts](https://github.com/MauricioPerera/a2e-skills) — existing write-side flow

## 10. What "v1.0 candidate" means

- An agent can bootstrap a session that pins a DocStore+VectorStore pair to specific commits (reproducible RAG)
- A skill-repo maintainer can `git log` to see exactly who added which skill when and why
- A second machine `git clone`s and has a fully-functional local replica
- Adapters perform within the latency bounds of section 6 on a realistic dataset
