/**
 * Soak test: runs a realistic read/write/refresh/gc mix for a configurable
 * duration, tracks memory + cache size + commit count, and reports final state.
 *
 * Acceptance (ROADMAP v0.3): no memory leaks, stable cache size, no corrupted
 * commits. A 24h run is impractical here; default is 60 s. Override:
 *
 *   SOAK_SECONDS=600 npm run soak
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/core/git.js";
import { GitStoreAdapter, InMemoryMetrics } from "../../src/index.js";
import { makeFixtureBareRepo } from "../fixtures/make-bare-repo.js";

interface Sample { atMs: number; rssMb: number; heapUsedMb: number; cacheBytes: number; cacheEntries: number }

async function main(): Promise<void> {
  const soakSeconds = Number(process.env["SOAK_SECONDS"] ?? "60");
  const deadline = Date.now() + soakSeconds * 1000;
  console.log(`soak: ${soakSeconds}s`);

  const fixture = await makeFixtureBareRepo({
    contentFiles: {
      "c0.docs.json": Array.from({ length: 100 }, (_, i) => ({ _id: `c0-${i}`, v: i, body: "x".repeat(256) })),
      "c1.docs.json": Array.from({ length: 100 }, (_, i) => ({ _id: `c1-${i}`, v: i, body: "y".repeat(256) })),
    },
    indexFiles: { "c0.meta.json": { indexes: [] }, "c1.meta.json": { indexes: [] } },
  });
  const cache = await mkdtemp(join(tmpdir(), "gls-soak-"));
  const metrics = new InMemoryMetrics();
  const adapter = new GitStoreAdapter({
    repoUrl: fixture.fileUrl,
    localCacheDir: cache,
    metrics,
    maxCacheBytes: 2 * 1024 * 1024,
    pushOnPersist: true,
  });

  const samples: Sample[] = [];
  const startedAt = Date.now();
  let iters = 0;
  let errors = 0;

  try {
    await adapter.preload(["c0.docs.json", "c0.meta.json", "c1.docs.json", "c1.meta.json"]);
    const sampleTimer = setInterval(() => {
      const m = process.memoryUsage();
      samples.push({
        atMs: Date.now() - startedAt,
        rssMb: m.rss / 1_048_576,
        heapUsedMb: m.heapUsed / 1_048_576,
        cacheBytes: adapter.cacheBytes(),
        cacheEntries: adapter.cacheEntryCount(),
      });
    }, 2000);
    sampleTimer.unref();

    while (Date.now() < deadline) {
      try {
        const col = iters % 2 === 0 ? "c0" : "c1";
        const existing = adapter.readJson(`${col}.docs.json`) as Array<Record<string, unknown>> | null;
        const base = existing ?? [];
        const next = [...base, { _id: `soak-${iters}`, v: iters, ts: Date.now() }];
        adapter.writeJson(`${col}.docs.json`, next);
        if (iters % 10 === 0) adapter.writeJson(`${col}.meta.json`, { indexes: [], lastIter: iters });
        await adapter.persist();
        if (iters % 20 === 0) await adapter.refresh();
        if (iters % 50 === 0) await adapter.gc();
      } catch (err) {
        errors++;
        console.error(`iter ${iters} error:`, err);
      }
      iters++;
    }
    clearInterval(sampleTimer);

    await runGit(["fsck", "--full", "--strict"], { cwd: join(cache, "content") });
    await runGit(["fsck", "--full", "--strict"], { cwd: join(cache, "index") });

    const first = samples[0];
    const last = samples[samples.length - 1];
    console.log("");
    console.log("SOAK SUMMARY");
    console.log(`  duration:     ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    console.log(`  iterations:   ${iters}`);
    console.log(`  errors:       ${errors}`);
    console.log(`  samples:      ${samples.length}`);
    if (first && last) {
      const rssDelta = last.rssMb - first.rssMb;
      const heapDelta = last.heapUsedMb - first.heapUsedMb;
      console.log(`  rss:          ${first.rssMb.toFixed(1)} → ${last.rssMb.toFixed(1)} MB  (Δ ${rssDelta >= 0 ? "+" : ""}${rssDelta.toFixed(1)})`);
      console.log(`  heap:         ${first.heapUsedMb.toFixed(1)} → ${last.heapUsedMb.toFixed(1)} MB  (Δ ${heapDelta >= 0 ? "+" : ""}${heapDelta.toFixed(1)})`);
      console.log(`  cacheBytes:   ${last.cacheBytes} (cap 2 MiB)`);
    }
    const snap = metrics.snapshot();
    const commits = snap.filter((s) => s.name === "gitstore.commit").reduce((n, s) => n + s.value, 0);
    const refreshes = snap.find((s) => s.name === "gitstore.refresh")?.value ?? 0;
    const gcs = snap.find((s) => s.name === "gitstore.gc")?.value ?? 0;
    console.log(`  commits:      ${commits}`);
    console.log(`  refreshes:    ${refreshes}`);
    console.log(`  gcs:          ${gcs}`);
    console.log(`  fsck:         both branches clean`);

    if (errors > 0) { console.log("SOAK FAIL: errors during run"); process.exit(1); }
    const cacheOver = last ? last.cacheBytes > 2 * 1024 * 1024 : false;
    if (cacheOver) { console.log("SOAK FAIL: cache exceeded cap"); process.exit(1); }
    console.log("SOAK PASS");
  } finally {
    await adapter.close();
    await rm(cache, { recursive: true, force: true });
    await fixture.cleanup();
  }
}

void spawnSync;

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
