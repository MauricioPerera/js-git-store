#!/usr/bin/env node
/**
 * Cache-eviction benchmark.
 *
 * Repeatedly loads N distinct blobs into a cache whose maxBytes is set
 * smaller than the total working set. This forces the LRU to evict on
 * every miss past the steady-state working size. Measures:
 *   - per-fetch wall time when serving from git (cold)
 *   - per-fetch wall time when serving from cache (hit)
 *   - bytes resident vs. bytes touched (the eviction effect)
 *
 * Use this to spot regressions in the cache accounting / LRU touch
 * logic in src/core/cache-layer.ts.
 *
 * Run: npm run bench:cache-eviction
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
  const N = Number.parseInt(process.env["BENCH_N"] ?? "200", 10);
  const PAYLOAD = Number.parseInt(process.env["BENCH_PAYLOAD"] ?? "16384", 10); // 16 KiB per blob
  const totalBytes = N * PAYLOAD;
  const maxBytes = Math.floor(totalBytes / 4); // working set fits 1/4

  console.log(`config: ${N} blobs × ${PAYLOAD} B = ${(totalBytes / 1024).toFixed(0)} KiB total`);
  console.log(`cache cap: ${(maxBytes / 1024).toFixed(0)} KiB (forces ~${(N * 3 / 4).toFixed(0)} evictions per full pass)`);

  const contentFiles: Record<string, Buffer> = {};
  const filenames: string[] = [];
  for (let i = 0; i < N; i++) {
    const name = `blob-${String(i).padStart(4, "0")}.bin`;
    filenames.push(name);
    contentFiles[name] = Buffer.alloc(PAYLOAD, i % 256);
  }

  const fixture = await makeFixtureBareRepo({ contentFiles, indexFiles: {} });
  const cacheDir = await mkdtemp(join(tmpdir(), "gls-evict-bench-"));
  try {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: cacheDir,
      maxCacheBytes: maxBytes,
    });
    await adapter.preload([]);

    // Cold pass: forces eviction on every blob past the cap.
    const tCold0 = hrMs();
    await adapter.preload(filenames);
    const tCold1 = hrMs();
    const coldPer = (tCold1 - tCold0) / N;
    console.log(`cold pass: ${(tCold1 - tCold0).toFixed(0)} ms total · ${coldPer.toFixed(2)} ms/blob`);
    console.log(`  resident: ${adapter.cacheBytes()} B in ${adapter.cacheEntryCount()} entries (cap ${maxBytes} B)`);
    if (adapter.cacheBytes() > maxBytes) {
      console.error(`FAIL: resident ${adapter.cacheBytes()} > cap ${maxBytes}`);
      process.exit(1);
    }

    // Hit pass: read only the last quarter, all of which should be cached.
    const hot = filenames.slice(Math.floor(N * 3 / 4));
    const tHit0 = hrMs();
    for (const f of hot) adapter.readBinShared(f);
    const tHit1 = hrMs();
    const hitPer = (tHit1 - tHit0) / hot.length;
    console.log(`hit pass:  ${(tHit1 - tHit0).toFixed(2)} ms total · ${hitPer.toFixed(4)} ms/blob (${hot.length} reads)`);

    // Check that the first quarter is gone (was evicted, returns null).
    const evicted = filenames.slice(0, Math.floor(N / 4));
    let missing = 0;
    for (const f of evicted) if (adapter.readBinShared(f) === null) missing++;
    console.log(`evicted:   ${missing}/${evicted.length} of the first quarter is no longer in cache`);

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
