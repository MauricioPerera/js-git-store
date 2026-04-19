# CONTRACT — js-git-store

Execution contract for a coding agent. The agent MUST read SPECIFICATION.md and ARCHITECTURE.md before writing code; this file alone is insufficient context.

## 1. Objective

Build `js-git-store`: two pluggable storage adapters that persist data in a git repository using a "tree-first, blob-on-demand" layout. The adapters implement the `StorageAdapter` interface of `js-doc-store` and `js-vector-store` respectively, so either library can be switched from `FileStorageAdapter` to `GitStorageAdapter` without code changes.

Success: both adapters pass the host libraries' existing test suites plus the integration tests in `tests/integration/` using a local bare repo fixture. Node 20+, zero runtime deps.

## 2. Inputs and Outputs

### Doc adapter

```ts
// Constructor
new GitDocStoreAdapter({
  repoUrl: string,        // https or ssh
  indexRef?: string,       // default "index" — orphan branch, metadata + partitions
  contentRef?: string,     // default "main"  — content branch, full blobs
  localCacheDir: string,   // where to keep the shallow clone of indexRef + fetched blobs
  authEnvVar?: string,     // env var holding token (never hardcoded); unset = public
  autoCommit?: boolean,    // default true — every write creates a commit
  pushOnWrite?: boolean,   // default false — caller decides when to push
  regenerateIndexHook?: (changedCollections: string[]) => Promise<void>,
})

// Interface conforming to js-doc-store StorageAdapter
interface DocAdapter {
  readCollection(name: string): Promise<Doc[]>;
  writeCollection(name: string, docs: Doc[]): Promise<void>;
  readMeta(name: string): Promise<CollectionMeta>;
  writeMeta(name: string, meta: CollectionMeta): Promise<void>;
  readIndex(name: string, field: string): Promise<IndexData | null>;
  writeIndex(name: string, field: string, data: IndexData): Promise<void>;
  listCollections(): Promise<string[]>;
  close(): Promise<void>;
}
```

### Vector adapter

```ts
new GitVectorStoreAdapter({
  repoUrl: string,
  indexRef?: string,       // default "index" — IVF centroids, cell map, quantized recall vectors
  contentRef?: string,     // default "main"  — full-precision vectors per IVF cell
  localCacheDir: string,
  authEnvVar?: string,
  autoCommit?: boolean,
  pushOnWrite?: boolean,
})

interface VectorAdapter {
  readCollection(name: string): Promise<VectorCollectionBundle>;
  writeCollection(name: string, bundle: VectorCollectionBundle): Promise<void>;
  readIVFCell(name: string, cellId: number): Promise<CellData>;
  listCollections(): Promise<string[]>;
  close(): Promise<void>;
}
```

Exact method signatures MUST be discovered by reading the current `StorageAdapter` definition in the upstream repos (commit pinned in `PATTERNS` section). This contract names the shape; the agent must match upstream exactly.

## 3. Pinned Stack and Dependencies

- Runtime: Node.js 20 LTS (Workers support deferred to v0.2)
- Language: TypeScript 5.6+, strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- Test: vitest (not jest)
- Build: `tsc --noEmit` for typecheck, `tsup` or raw `tsc` for dist
- Runtime deps: **zero** — the project matches the zero-dep philosophy of its hosts
- DO NOT use: `simple-git`, `nodegit`, `isomorphic-git`, or any git library. Use `node:child_process.spawn("git", ...)` directly
- DO NOT use: lodash, axios, zod, or any utility dep. Prefer hand-rolled, small, explicit
- DO NOT use: `fs.promises.writeFile` without atomic-write semantics (tmp + fsync + rename) for on-disk cache writes

## 4. Project Patterns

Two upstream reference projects establish the StorageAdapter interface and existing adapter style:

- js-doc-store: `https://github.com/MauricioPerera/js-doc-store` — read `src/adapters/*` for the exact method signatures `GitDocStoreAdapter` must match
- js-vector-store: `https://github.com/MauricioPerera/js-vector-store` — same, for `GitVectorStoreAdapter`

The git-tree + blob-on-demand pattern already exists in production at:

- a2e-skills: `https://github.com/MauricioPerera/a2e-skills` — orphan `index` branch, `main` content, `tools/gen-index.ts` + `tools/push-index.sh` show the write-side flow
- a2e-shell: `https://github.com/MauricioPerera/a2e-shell` — `src/catalog/cache.ts` shows the read-side (partial clone, blob fetch on demand, flock, LRU sweep)

The agent MUST read both to understand the pattern. Do not reimplement; extract.

Conventions to match:

- Atomic writes: tmp file + fsync + rename, same as `a2e-shell/src/session/persistence.ts`
- Flock for cross-process write coordination: `open(path, 'wx')` pattern from `a2e-shell/src/catalog/cache.ts`
- Error codes: if any error surface is needed, match `a2e-shell/src/errors.ts` — enum-style ErrorCode, explicit httpStatus fallback

## 5. Artifacts to Produce

1. `src/core/git.ts`
   - Thin wrapper over `child_process.spawn("git", ...)` with timeout, stderr capture, auth env inheritance
   - Max 200 lines
   - Exports: `runGit(args, opts)`, `cloneShallow(...)`, `fetchBlob(...)`, `commit(...)`, `push(...)`

2. `src/core/index-branch.ts`
   - Manages the orphan `index` branch layout (manifest.json + per-collection meta/index files)
   - Max 250 lines
   - Writes delegate to `regenerateIndexHook` if supplied; otherwise uses an inline regenerator

3. `src/core/blob-fetch.ts`
   - On-demand blob retrieval with LRU-bounded local cache
   - Max 200 lines
   - Uses atomic writes to cache dir

4. `src/core/commit-queue.ts`
   - Serializes writes so concurrent `insert()` calls don't race commits
   - Max 150 lines

5. `src/adapters/doc.ts`
   - `GitDocStoreAdapter` implementing js-doc-store interface
   - Max 300 lines
   - Delegates to `core/*`; no git logic inline

6. `src/adapters/vector.ts`
   - `GitVectorStoreAdapter` implementing js-vector-store interface
   - Max 350 lines
   - IVF cell → directory mapping handled here

7. `src/index.ts`
   - Barrel export. Max 30 lines.

8. `tests/unit/**/*.test.ts`
   - Pure-function tests for core (git arg building, index layout calc, LRU eviction)

9. `tests/integration/doc-adapter.test.ts`
   - Spin up a local bare git repo, point the adapter at it, run the full js-doc-store test suite against it

10. `tests/integration/vector-adapter.test.ts`
    - Same, against js-vector-store's test suite

11. `examples/skills-catalog/README.md` + runnable script
    - Migrate a2e-skills from static-CI-index to js-git-store. Shows the doc adapter in practice.

12. `examples/vector-rag/README.md` + runnable script
    - Vector RAG over a git-backed knowledge base. Shows the vector adapter in practice.

## 6. Acceptance Criteria

- [ ] `npm test` passes with 100% tests green
- [ ] `npm run typecheck` passes with no errors
- [ ] `npm run lint` passes with no warnings
- [ ] Zero runtime dependencies in `dependencies` (devDependencies OK)
- [ ] Both adapters pass the upstream test suite of their host library when substituted for `FileStorageAdapter`
- [ ] Cold-read latency for a random blob in a 1,000-doc collection < 100 ms on a local-file remote (`file:///...`)
- [ ] No file exceeds the line limit from section 5
- [ ] No `any` in TypeScript source. `unknown` + narrowing is acceptable
- [ ] No console.log. Use an injectable logger if needed (default: noop)
- [ ] `examples/` scripts run end-to-end and leave no stale state

## 7. Hard Constraints

- DO NOT add any git library (`isomorphic-git`, `simple-git`, `nodegit`). Only `node:child_process.spawn("git", ...)`.
- DO NOT touch files outside `src/`, `tests/`, `examples/`, `package.json`, `tsconfig.json`.
- DO NOT vendor copies of js-doc-store or js-vector-store. Reference them as peer dependencies in tests.
- DO NOT implement CF Workers support in v0.1. It requires an entirely different transport (GitHub API) and is explicitly deferred. Reject any temptation to add a "workers adapter" variant now.
- DO NOT write explanatory comments inside code beyond JSDoc on exported symbols.
- DO NOT generate README or CHANGELOG files beyond the single root README.md and what this contract explicitly lists.
- DO NOT commit. Leave changes in the working directory for the human to review.
- DO NOT publish to npm. Leave `private: true` in package.json.
- If a criterion from section 6 cannot be met, STOP and report the block. Do not implement silent workarounds (e.g., removing a failing test "because it was flaky").
- If the upstream StorageAdapter interface has changed since this contract was written and the new shape is incompatible, STOP and report. Do not guess.
