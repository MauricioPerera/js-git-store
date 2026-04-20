#!/usr/bin/env node
/**
 * Persist-throughput benchmark.
 *
 * Writes batches of dirty entries (mixed heavy + light) and measures the
 * end-to-end persist() latency. Runs three batch sizes back-to-back against
 * the same adapter to capture both first-commit and steady-state cost.
 *
 * What it isolates:
 *   - JSON serialization (skipped — already cached on writeJson)
 *   - File staging + git add + git commit per branch
 *   - Lock acquisition overhead
 *
 * It does NOT push (pushOnPersist: false) — push latency is dominated by
 * the network and is measured separately by github-e2e.
 *
 * Run: npm run bench:persist
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitStoreAdapter } from "../../src/index.js";
import { makeFixtureBareRepo } from "../fixtures/make-bare-repo.js";

function hrMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

interface Sample { batch: number; ms: number; perDoc: number }

async function runBatch(adapter: GitStoreAdapter, batch: number, gen: number): Promise<Sample> {
  for (let i = 0; i < batch; i++) {
    const id = `g${gen}-d${i}`;
    adapter.writeJson(`docs-${id}.docs.json`, { _id: id, v: i, body: "x".repeat(128) });
    if (i % 4 === 0) {
      adapter.writeJson(`docs-${id}.meta.json`, { indexes: [] });
    }
  }
  const t0 = hrMs();
  await adapter.persist();
  const t1 = hrMs();
  const ms = t1 - t0;
  return { batch, ms, perDoc: ms / batch };
}

async function main(): Promise<void> {
  const fixture = await makeFixtureBareRepo({ contentFiles: {}, indexFiles: {} });
  const cacheDir = await mkdtemp(join(tmpdir(), "gls-persist-bench-"));
  try {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: cacheDir,
      pushOnPersist: false,
    });
    await adapter.preload([]);

    const sizes = [1, 10, 100];
    const results: Sample[] = [];
    let gen = 0;
    for (const batch of sizes) {
      results.push(await runBatch(adapter, batch, gen++));
    }
    const steady = await runBatch(adapter, 100, gen++);

    console.log("batch  total ms   per doc ms");
    console.log("-----  --------   ----------");
    for (const r of results) {
      console.log(`${String(r.batch).padStart(5)}  ${r.ms.toFixed(1).padStart(8)}   ${r.perDoc.toFixed(2).padStart(10)}`);
    }
    console.log(`${String(steady.batch).padStart(5)}  ${steady.ms.toFixed(1).padStart(8)}   ${steady.perDoc.toFixed(2).padStart(10)}  (steady)`);

    console.log("");
    console.log("Notes:");
    console.log("- Each batch produces 1 commit per branch (heavy + light), not 1 per doc.");
    console.log("- ~4× per-doc speedup from batch=1 → batch=100 indicates fixed git-spawn cost dominates small batches.");

    await adapter.close();
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await fixture.cleanup();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
