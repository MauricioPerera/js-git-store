# Example: vector-rag

Build a versioned RAG index over a git repository and query it via `GitVectorStoreAdapter`.

## Goal

- Demonstrate the complete workflow: ingest → embed → index → query
- Show the two-stage re-rank pattern (quantized recall + full-precision scoring)
- Prove that pinning to a specific commit SHA produces deterministic query results

## Prerequisites

- A corpus of documents (plain markdown is fine). A sample corpus generator is included at `generate-corpus.ts`.
- An embedding provider. The example uses Cloudflare Workers AI's `@cf/baai/bge-m3` (via REST API — set `CLOUDFLARE_API_TOKEN`). Any provider works.
- js-vector-store installed
- js-git-store implemented

## Workflow

### Phase 1: ingest + embed

```ts
import fs from "node:fs/promises";
import { VectorStore } from "js-vector-store";
import { GitVectorStoreAdapter } from "js-git-store";

const adapter = new GitVectorStoreAdapter({
  repoUrl: "file:///tmp/rag-index.git",  // local bare repo first
  localCacheDir: "./.cache/rag",
  rerankMode: "quantized-recall",
  authEnvVar: undefined,
});

const vectors = new VectorStore({ adapter });
const collection = vectors.collection("articles");

// For each doc in the corpus, compute embedding via your provider, then:
await collection.insert({
  id: "article-001",
  vector: embedding,           // Float32Array[768] from the provider
  metadata: { title: "...", body: "...", source: "..." },
});

// ... for all docs
await adapter.flush();
// Local repo now has a commit with all vectors. Nothing pushed.
```

### Phase 2: query

```ts
const queryEmbedding = await embed("what is the git tree + blob on demand pattern?");

const results = await collection.similaritySearch(queryEmbedding, {
  topK: 5,
  probes: 5,
});

// results is top-5 with { id, score, metadata }
// Behind the scenes: centroids fetched once (local), 5 cell blobs fetched,
// quantized recall used for initial filtering, full-precision re-ranking at the end.
```

### Phase 3: reproducible query at a pinned SHA

```ts
const frozenSha = "abc1234";  // the commit we trust

const pinnedAdapter = new GitVectorStoreAdapter({
  repoUrl: "file:///tmp/rag-index.git",
  contentRef: frozenSha,       // ← NOT a branch
  localCacheDir: "./.cache/rag-pinned",
  rerankMode: "quantized-recall",
});

// Same query, guaranteed same results, regardless of subsequent updates to main.
```

## Acceptance for this example

- [ ] Ingestion of 1,000 sample docs produces a valid IVF index in < 60 s
- [ ] `similaritySearch` returns results in < 500 ms for top-5 with 5 probes on the 1,000-doc index
- [ ] Re-running the same query against a SHA-pinned adapter returns byte-identical results
- [ ] After pushing the repo to a real remote (GitHub), cloning from a second machine and running the same query works without any setup beyond `git clone + npm install`

## What this example does NOT do

- Production-grade embedding pipeline (batching, retry, backpressure). The ingestion script is sequential for clarity.
- Alternative embedding providers beyond one example. The adapter is provider-agnostic; swap the `embed()` function.
- Multi-tenant index separation. One repo per index — compose at the application layer if needed.
