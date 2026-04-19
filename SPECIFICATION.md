# SPECIFICATION — js-git-store

Detailed technical specification. The agent should read this before writing code to understand the *why* behind decisions encoded in CONTRACT.md. Narrative context that does NOT belong in the contract but DOES belong in the agent's head before coding.

## 1. What this project is

`js-git-store` provides two pluggable storage adapters that let [`js-doc-store`](https://github.com/MauricioPerera/js-doc-store) and [`js-vector-store`](https://github.com/MauricioPerera/js-vector-store) persist their data in a git repository — with the specific layout "tree first, blob on demand". The result is a knowledge-base substrate that is:

- **Content-addressable**: every version of every record is a git SHA
- **Versioned by construction**: git log = full audit trail
- **Distributed by default**: clone = replica; pull = sync
- **Branch-oriented**: branches = dev/staging/prod or experiment variants
- **Edge-deployable (eventually)**: reads only need partial clone of the index branch + blob fetches; writes need a pushable remote

## 2. What problem it solves

Existing document and vector stores in JS land are:

- **Ephemeral** (in-memory) — no versioning, no audit
- **Filesystem-only** (FileStorageAdapter) — versioning = manual snapshots, no branching, no signatures
- **KV-backed** (CF Workers KV) — no history, no branches, not portable

Commercial products with version semantics (Dolt, Datomic, LakeFS) are Go/JVM/closed, not JS-native, not edge-deployable.

This project fills the gap: **git-native storage for structured JS data**, usable for knowledge bases, config stores, knowledge graphs, versioned RAG, any read-heavy domain where history matters.

## 3. The "tree first, blob on demand" pattern

A single git repository holds two refs that serve different purposes:

### `index` branch (orphan — no shared history with main)

Small. Contains only metadata + partitions:

```
index/
├── manifest.json              # top-level pointers
├── collections/
│   ├── users.meta.json        # schema, count, last-modified, etc.
│   ├── users.idx.email.json   # email index (hash or sorted)
│   └── users.idx.age.json
└── vectors/
    ├── embeddings.centroids.bin    # IVF centroids (~KB)
    ├── embeddings.cell-map.json    # "cell N → [vec IDs]"
    └── embeddings.quantized.bin    # 1-bit recall vectors (optional)
```

Clients clone this branch **shallow and full** (`--depth=1 --single-branch`). Total size typically < 100 MB even for million-document datasets. They can keep it forever in local cache.

### `main` branch (content)

Contains the heavy blobs:

```
main/
├── collections/
│   ├── users.docs.jsonl       # full documents, one per line
│   └── orders.docs.jsonl
└── vectors/
    ├── embeddings/
    │   ├── cell-0000.vec.bin  # full-precision vectors in IVF cell 0
    │   ├── cell-0001.vec.bin
    │   └── ...
    └── embeddings.docs.jsonl  # metadata per vector
```

Clients clone this branch **partial** (`--filter=blob:none`). Git fetches blobs lazily when accessed. Typical pattern:

1. Agent asks js-doc-store for `users.find({email: "x@y"})`
2. Adapter reads `users.idx.email.json` (already local from index branch)
3. Index says matching docs are at file offset ranges within `users.docs.jsonl`
4. Adapter triggers `git fetch <content-ref>:collections/users.docs.jsonl` — pulls only that file's blob
5. Reads offsets, returns matching docs

For vectors it's cleaner because IVF already partitions:

1. Agent asks js-vector-store for `similaritySearch(queryVec, topK=10, probes=5)`
2. Adapter uses local centroids to identify 5 cells
3. Adapter `git fetch`es those 5 cell blobs
4. Scores, returns top-10

## 4. Architectural invariants

### Writes go through a commit queue

All mutations are serialized in-process via a mutex. Two `insert()` calls made concurrently are committed one after the other, not merged into one commit. This keeps commit history readable and avoids git locking issues.

Cross-process concurrency: the same `open(path, 'wx')` flock pattern used by a2e-shell's catalog cache. If another process holds the lock, wait-and-retry up to the configured timeout.

### Reads never hit the remote unless the blob is absent locally

Local cache is authoritative for reads. The adapter only triggers `git fetch` on a cache miss. Successful fetches populate the local cache atomically (tmp + fsync + rename).

### Index branch is regenerated, not incrementally edited

A write mutates `main` (append to `users.docs.jsonl`, add new vector cell, etc.), then triggers an index regeneration. The regenerator reads the mutated content and rewrites the relevant `index` branch files.

Two strategies for triggering:
- **Eager**: every write regenerates the affected index files immediately and includes them in the same commit
- **Batched**: writes stack, a background flush regenerates + commits every N ops or every T seconds (analogous to a WAL)

MVP: eager. Batching is a v0.2 enhancement.

### Push is caller-controlled

`autoCommit: true` (default) means every write creates a commit. `pushOnWrite: false` (default) means the adapter does NOT push automatically. The caller decides when to push — after a batch of ops, on shutdown, on explicit `flush()`.

This matters because:
- Most use cases do many writes then one push
- Pushing per-op would make throughput unusable
- Integrating with PR workflows means the caller might want to push to a feature branch and open a PR, not push to main

## 5. Why IVF is a natural fit (vector adapter specific)

IVF (Inverted File Index) partitions the vector space into cells via k-means. Each vector belongs to one cell. A query finds the top-k nearest cells to the query vector, then scores vectors only within those cells.

This maps 1:1 to git tree structure:

```
vectors/embeddings/
├── cell-0000.vec.bin
├── cell-0001.vec.bin
├── ...
```

Query cost = k cell fetches. For k=5 probes on a 1M-vector dataset with 1000 cells, a query fetches ~5 MB of blobs instead of downloading the full 3 GB corpus.

Matryoshka-style re-ranking works naturally on top:
1. Load quantized 1-bit recall vectors from the index branch (already local, ~92 MB for 1M vectors)
2. Score approximately, pick top-100 candidates
3. Fetch full-precision vectors for only those 100 from the content branch
4. Re-rank with full-precision cosine

This combination (quantized local + full-precision on-demand) is what makes the git-backed vector store genuinely competitive with server-based stores for moderate-scale RAG.

## 6. Scale ceiling (honest)

### Reads

- Tree index branch: practical ceiling ~100 MB. That corresponds to ~1M vectors quantized to 1-bit, or ~10M docs of pure metadata. Past that, the index gets slow to clone.
- Blob fetch latency: ~10-100 ms per fetch (network RTT dominated). Fine for retrieval, bad for real-time queries at > 10 qps.

### Writes

- Per-commit overhead: ~50-200 ms (spawn git + hash + commit). Batching to 100 ops per commit = 1000 writes/sec theoretical.
- Cross-process contention: serialized via flock. A hot repo with 10 writers will queue up.

### What you SHOULDN'T build with this

- Live sessions / cart data (write-heavy, latency-sensitive)
- Logs, metrics, telemetry
- Multi-tenant shared state (one repo per tenant doesn't scale)
- Real-time collaborative editing
- Billion-scale vector search (we're targeting edge + medium scale, not Pinecone replacement)

### What you SHOULD build with this

- Agent knowledge bases (skills, docs, prompts)
- Config / feature-flag stores with review workflow
- Versioned RAG indices pinned to embedding model version
- Scientific dataset archives with experiment branches
- Content catalogs where PR = editorial workflow

## 7. Integration with the broader a2e ecosystem

This project was conceived during work on [a2e-shell](https://github.com/MauricioPerera/a2e-shell), an HTTP server that exposes bash as a primitive tool for LLM agents, and [a2e-skills](https://github.com/MauricioPerera/a2e-skills), a git-backed catalog of skills/docs/prompts/templates consumed by a2e-shell.

a2e-skills today uses a CI-regenerated index branch and manual file writes. Migration to js-git-store would:

- Replace `tools/gen-index.ts` + `tools/push-index.sh` with programmatic writes through the doc adapter
- Enable new skill types: skills with a vector-indexed description (for semantic skill discovery via js-vector-store)
- Keep the on-disk layout compatible so a2e-shell's current catalog consumer (which reads `skills.json` partitions) keeps working

The example in `examples/skills-catalog/` MUST demonstrate this migration.

## 8. Success criteria (beyond the contract)

A "v1.0 candidate" exists when:

- An agent can bootstrap a session that pins both a doc-store AND a vector-store to specific commits (reproducible RAG)
- A skill repo maintainer can `git log` to see exactly who added which skill when and why (commit messages written by the adapter on their behalf)
- A second machine can clone the repo and have a fully-functional local replica with zero setup beyond `git clone + npm install`
- The adapters perform within the latency bounds of section 6 on a realistic dataset (see `examples/` for realistic)

## 9. Explicit non-goals

- Do not build a web UI. This is a library.
- Do not build a REST/HTTP server. That's the caller's job (a2e-shell style).
- Do not implement replication between multiple git hosts. Git's built-in remotes are enough.
- Do not implement transactions across repos. One repo = one "database".
- Do not compete with Dolt/Datomic on SQL/query richness. Inherit whatever js-doc-store provides.
- Do not attempt to deduplicate across collections. Each collection is independent.

## 10. What the agent SHOULD cross-reference before writing code

1. Read the `StorageAdapter` interface in js-doc-store source — this is the contract the doc adapter must satisfy exactly
2. Read the `StorageAdapter` interface in js-vector-store source — same for the vector adapter
3. Read `a2e-shell/src/catalog/cache.ts` — this is the canonical implementation of "shallow clone + partial fetch + LRU + flock" that js-git-store is extracting/generalizing. Treat it as reference code, not as something to copy
4. Read `a2e-skills/tools/gen-index.ts` and `a2e-skills/tools/push-index.sh` — the existing write-side flow
5. Read `a2e-skills/INDEX-SCHEMA.json` — the schema conventions js-doc-store's doc adapter's index branch will echo
