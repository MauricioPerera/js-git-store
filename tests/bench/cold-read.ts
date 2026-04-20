#!/usr/bin/env node
/**
 * Cold-read benchmark.
 *
 * Builds a 1,000-document fixture, clones it cold in a fresh adapter instance,
 * preloads the heavy + light files, and measures the end-to-end latency.
 *
 * Acceptance (CONTRACT §7): cold < 500 ms, warm < 50 ms on a file:// remote.
 *
 * Run: npm run bench:cold-read
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

async function main(): Promise<void> {
  const docs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 1000; i++) {
    docs.push({ _id: `d${i}`, v: i, body: "x".repeat(256) });
  }
  const fixture = await makeFixtureBareRepo({
    contentFiles: { "bench.docs.json": docs },
    indexFiles: { "bench.meta.json": { indexes: [] } },
  });
  const cacheRoot = await mkdtemp(join(tmpdir(), "gls-bench-"));
  try {
    const coldDir = join(cacheRoot, "cold");
    const cold = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: coldDir });
    const tCold0 = hrMs();
    await cold.preload(["bench.docs.json", "bench.meta.json"]);
    const arr = cold.readJson("bench.docs.json") as unknown[];
    const tCold1 = hrMs();
    if (!Array.isArray(arr) || arr.length !== 1000) throw new Error(`expected 1000 docs, got ${arr?.length}`);
    console.log(`cold  ${(tCold1 - tCold0).toFixed(1)} ms  (1000 docs, 1 heavy + 1 light file)`);
    await cold.close();

    const warm = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: coldDir });
    const tWarm0 = hrMs();
    await warm.preload(["bench.docs.json", "bench.meta.json"]);
    warm.readJson("bench.docs.json");
    const tWarm1 = hrMs();
    console.log(`warm  ${(tWarm1 - tWarm0).toFixed(1)} ms  (reusing existing clones)`);
    await warm.close();

    const tRepeated0 = hrMs();
    for (let i = 0; i < 100; i++) warm.readJson("bench.docs.json");
    const tRepeated1 = hrMs();
    console.log(`100× sync readJson: ${(tRepeated1 - tRepeated0).toFixed(2)} ms`);

    console.log("");
    console.log("Budgets (Linux CI): cold < 500 ms, warm < 50 ms");
    console.log("Note: git-spawn latency is ~100-300 ms per call on Windows, ~5-20 ms on Linux.");
    if (process.env["BENCH_GATE"] === "1") {
      const coldMs = tCold1 - tCold0;
      const warmMs = tWarm1 - tWarm0;
      let failed = false;
      if (coldMs > 500) { console.error(`FAIL: cold ${coldMs.toFixed(1)} ms > 500 ms`); failed = true; }
      if (warmMs > 50) { console.error(`FAIL: warm ${warmMs.toFixed(1)} ms > 50 ms`); failed = true; }
      if (failed) process.exit(1);
      console.log("BENCH GATE PASS");
    } else {
      console.log("Gating disabled (set BENCH_GATE=1 to enforce budgets).");
    }
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
    await fixture.cleanup();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
