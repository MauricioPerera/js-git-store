#!/usr/bin/env node
/**
 * Vector-load benchmark.
 *
 * Seeds N vectors of dimension D as a single .bin blob (Float32) plus the
 * matching .json metadata, then measures:
 *   1. Cold load: fresh clone + preload + first readBin
 *   2. Warm load: re-open the same cache dir, preload (no-op fetch), readBin
 *   3. Hot reads: 1000 sync readBin calls against the in-memory cache
 *
 * The adapter doesn't compute similarity itself — that lives in
 * js-vector-store. This benchmark isolates the adapter's responsibility:
 * moving bytes from git → memory.
 *
 * Defaults: N=10_000, D=768. Override with BENCH_N / BENCH_D env vars.
 *
 * Run: npm run bench:vector-load
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

function buildVectors(n: number, d: number): Float32Array {
  const out = new Float32Array(n * d);
  for (let i = 0; i < out.length; i++) out[i] = Math.fround((i % 1024) / 1024 - 0.5);
  return out;
}

async function main(): Promise<void> {
  const N = Number.parseInt(process.env["BENCH_N"] ?? "10000", 10);
  const D = Number.parseInt(process.env["BENCH_D"] ?? "768", 10);
  const HOT = 1000;

  const vectors = buildVectors(N, D);
  const bytes = vectors.byteLength;
  console.log(`config: ${N.toLocaleString()} vectors × ${D} dims = ${(bytes / 1024 / 1024).toFixed(1)} MiB`);

  const fixture = await makeFixtureBareRepo({
    contentFiles: { "embeddings.bin": Buffer.from(vectors.buffer) },
    indexFiles: { "embeddings.json": { dim: D, count: N } },
  });
  const cacheRoot = await mkdtemp(join(tmpdir(), "gls-vec-bench-"));
  try {
    const coldDir = join(cacheRoot, "cold");
    const cold = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: coldDir,
      maxCacheBytes: bytes * 4,
    });
    const tCold0 = hrMs();
    await cold.preload(["embeddings.bin", "embeddings.json"]);
    const ab = cold.readBin("embeddings.bin");
    const tCold1 = hrMs();
    if (!ab || ab.byteLength !== bytes) throw new Error(`cold: expected ${bytes} bytes, got ${ab?.byteLength}`);
    console.log(`cold  ${(tCold1 - tCold0).toFixed(1)} ms  (clone + preload + first readBin)`);
    await cold.close();

    const warm = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: coldDir,
      maxCacheBytes: bytes * 4,
    });
    const tWarm0 = hrMs();
    await warm.preload(["embeddings.bin", "embeddings.json"]);
    warm.readBin("embeddings.bin");
    const tWarm1 = hrMs();
    console.log(`warm  ${(tWarm1 - tWarm0).toFixed(1)} ms  (reuse clone, repopulate cache)`);

    const tHot0 = hrMs();
    for (let i = 0; i < HOT; i++) warm.readBinShared("embeddings.bin");
    const tHot1 = hrMs();
    const perCall = (tHot1 - tHot0) / HOT;
    console.log(`hot   ${perCall.toFixed(4)} ms/call × ${HOT} (in-memory readBinShared, zero-copy)`);
    await warm.close();

    console.log("");
    console.log("Targets (TEST-PLAN.md): cold p95 < 300 ms, warm < 50 ms (Linux, 10k × 768)");
    if (process.env["BENCH_GATE"] === "1") {
      const coldMs = tCold1 - tCold0;
      const warmMs = tWarm1 - tWarm0;
      let failed = false;
      if (coldMs > 300) { console.error(`FAIL: cold ${coldMs.toFixed(1)} ms > 300 ms`); failed = true; }
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
