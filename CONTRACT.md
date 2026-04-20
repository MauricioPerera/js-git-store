# CONTRACT — js-git-store

Execution contract for a coding agent. The agent MUST read SPECIFICATION.md and ARCHITECTURE.md before writing code; this file alone is insufficient context.

## 1. Objective

Build `js-git-store`: **one unified** pluggable storage adapter that persists data in a git repository using a "tree-first, blob-on-demand" layout. The same adapter satisfies both the `StorageAdapter` shape of `js-doc-store` and `js-vector-store`, so either host can be switched from `FileStorageAdapter` to `GitStoreAdapter` without code changes beyond instantiation.

Success: the adapter, when passed to `new DocStore(adapter)` or any vector-store host, makes those hosts work against a git repo instead of the local filesystem. Node 20+, zero runtime deps.

## 2. Upstream pin and interface (verified 2026-04-19)

Verified upstreams (default branch `master`, not `main`):

- [js-doc-store@master](https://github.com/MauricioPerera/js-doc-store/blob/master/js-doc-store.js) — `FileStorageAdapter` at L210, `DocStore(dirOrAdapter)` constructor at L1138
- [js-vector-store@master](https://github.com/MauricioPerera/js-vector-store/blob/master/js-vector-store.js) — `FileStorageAdapter` at L301 (adds `readBin/writeBin`)

The real adapter surface is **sync read/write + async preload/persist**:

```ts
interface StorageAdapter {
  // Sync — served from an in-memory cache the adapter maintains.
  readJson(filename: string): unknown | null;
  writeJson(filename: string, data: unknown): void;
  delete(filename: string): void;

  // Optional, only for vector-store:
  readBin(filename: string): ArrayBuffer | null;
  writeBin(filename: string, buffer: ArrayBuffer | Uint8Array): void;

  // Optional, present on remote-backed adapters:
  preload(filenames: string[]): Promise<void>;  // hydrate cache from remote
  persist(): Promise<void>;                     // flush dirty cache to remote
}
```

Host libraries pick filenames. Known shapes:

- `<col>.docs.json` — DocStore documents (HEAVY)
- `<col>.meta.json` — DocStore index definitions
- `<col>.<field>.idx.json` — DocStore hash index
- `<col>.<field>.sidx.json` — DocStore sorted index
- `<col>.bin` / `<col>.q8.bin` / `<col>.b1.bin` — VectorStore vectors (HEAVY)
- `<col>.json` / `<col>.q8.json` / `<col>.b1.json` — VectorStore manifest / centroids

The adapter must NOT embed knowledge of these names. It MUST expose a `heavyFileRegex` config (default `/\.(bin|docs\.json)$/`) that routes filenames to the heavy-or-light storage branch.

## 3. Adapter configuration

```ts
new GitStoreAdapter({
  repoUrl: string,               // https, ssh, or file://
  indexRef?: string,             // default "index" — orphan branch, light files, shallow clone
  contentRef?: string,           // default "main"  — content branch, heavy files, partial clone
  localCacheDir: string,         // where clones + cache live
  authEnvVar?: string,           // env var name holding token (never hardcode)
  pushOnPersist?: boolean,       // default false
  heavyFileRegex?: RegExp,       // default /\.(bin|docs\.json)$/
  logger?: Logger,               // default noop
  gitTimeoutMs?: number,         // default 30_000
  lockTimeoutMs?: number,        // default 30_000
  staleLockMs?: number,          // default 60_000
  author?: { name: string; email: string },  // commit identity
  commitMessage?: (changedFiles: string[]) => string,
})
```

## 4. Pinned stack and dependencies

- Runtime: Node.js 20 LTS (Workers support deferred to v0.2)
- Language: TypeScript 5.6+, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- Test: vitest
- Build: `tsc --noEmit` for typecheck, `tsc` for dist
- Runtime deps: **zero** — matches the zero-dep philosophy of the hosts
- DO NOT use: `simple-git`, `nodegit`, `isomorphic-git`, or any git library. Use `node:child_process.spawn("git", ...)` directly
- DO NOT use: lodash, axios, zod, or any utility dep

## 5. Project patterns

The git-tree + blob-on-demand pattern already exists in production at:

- [a2e-skills](https://github.com/MauricioPerera/a2e-skills) — orphan index + main content
- [a2e-shell/src/catalog/cache.ts](https://github.com/MauricioPerera/a2e-shell) — read-side: partial clone, blob fetch on demand, flock, LRU sweep

The [VercelBlobAdapter](https://github.com/MauricioPerera/js-doc-store/blob/master/vercel-blob-adapter.js) and `CloudflareKVAdapter` in the upstream show the **exact sync-cache + async-persist pattern** the git adapter must follow. Read them before coding.

Conventions to match:

- Atomic writes: tmp + fsync + rename
- Flock for cross-process coordination: `open(path, 'wx')`
- Redactor applied to stderr AND argv-in-error-messages

## 6. Artifacts to produce

1. `src/core/git.ts` — `spawn("git", …)` wrapper. ≤ 200 lines.
2. `src/core/branch-router.ts` — routes filenames to index/content branch per `heavyFileRegex`. ≤ 80 lines.
3. `src/core/blob-fetch.ts` — on-demand blob retrieval + LRU-bounded cache. ≤ 200 lines.
4. `src/core/commit-queue.ts` — serialized writes + flock. ≤ 150 lines.
5. `src/core/atomic-write.ts` — tmp + fsync + rename. ≤ 50 lines.
6. `src/adapters/git-store.ts` — `GitStoreAdapter` with sync read/write + async preload/persist/refresh/gc. ≤ 400 lines. (Bumped from 350 as v0.3/v0.4 legitimately grew the surface: metrics wiring, backpressure, refresh, gc, LRU touch.)
7. `src/index.ts` — barrel. ≤ 30 lines.
8. `tests/unit/**/*.test.ts` — pure-function tests.
9. `tests/integration/git-store.test.ts` — end-to-end: instantiate a real `DocStore(adapter)` against a file:// bare repo fixture; run real DocStore operations.
10. `tests/integration/vector-store.test.ts` — same with `readBin/writeBin`.
11. `tests/integration/concurrency.test.ts` — cross-process flock.
12. `examples/skills-catalog/run.ts` — real `DocStore` usage on a git-backed catalog.
13. `examples/vector-rag/run.ts` — real `VectorStore` usage on a git-backed index.

## 7. Acceptance criteria

- [ ] `npm test` passes with 100% tests green
- [ ] `npm run typecheck` passes with no errors
- [ ] `npm run lint` passes with no warnings
- [ ] Zero runtime dependencies in `dependencies`
- [ ] `npm run example:skills` runs end-to-end, produces a real commit on the fixture bare repo, and a re-read returns the inserted data
- [ ] Cold-read of a random heavy blob in a 1,000-doc collection < 500 ms on a file:// remote; warm-read < 50 ms
- [ ] No file exceeds the line limit from section 6
- [ ] No `any` in TypeScript source. `unknown` + narrowing is acceptable
- [ ] No `console.log`. Use an injectable logger if needed (default: noop)

## 8. Hard constraints

- DO NOT add any git library (`isomorphic-git`, `simple-git`, `nodegit`). Only `node:child_process.spawn("git", ...)`.
- DO NOT touch files outside `src/`, `tests/`, `examples/`, `package.json`, `tsconfig*.json`, `vitest.config.ts`, `eslint.config.js`, `.github/workflows/*.yml`.
- DO NOT vendor copies of js-doc-store or js-vector-store. Reference them as peer dependencies in tests (or pin to the upstream git URL for integration).
- DO NOT implement CF Workers support in v0.1. Deferred to v2.0.
- DO NOT write explanatory comments inside code beyond JSDoc on exported symbols.
- DO NOT commit. Leave changes in the working directory.
- Pre-v1.0: DO NOT publish to npm. From v1.0 onward, publication is expected (see STABILITY.md); `private: true` was removed for the v1.0 release.
- If a criterion from section 7 cannot be met, STOP and report. No silent workarounds.
- If upstream interfaces change in an incompatible way, STOP and report. Do not guess.
