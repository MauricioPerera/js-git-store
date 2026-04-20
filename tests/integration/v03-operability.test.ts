import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitStoreAdapter, InMemoryMetrics } from "../../src/index.js";
import { makeFixtureBareRepo, type Fixture } from "../fixtures/make-bare-repo.js";

describe("v0.3 operability", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: { "c.docs.json": [{ _id: "1", v: 1 }] },
      indexFiles: { "c.meta.json": { indexes: [] } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-ops-"));
  });

  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("metrics: blob.fetch counter + histogram populate on preload", async () => {
    const metrics = new InMemoryMetrics();
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "m1"),
      metrics,
    });
    await adapter.preload(["c.docs.json", "c.meta.json"]);
    const snap = metrics.snapshot();
    const hits = snap.filter((s) => s.name === "gitstore.blob.fetch" && s.labels?.["result"] === "ok");
    expect(hits.length).toBe(2);
    const hist = snap.find((s) => s.name === "gitstore.blob.fetch.ms" && s.kind === "histogram");
    expect(hist).toBeDefined();
    expect(hist?.count).toBeGreaterThanOrEqual(1);
    await adapter.close();
  });

  it("metrics: commit counter increments on persist", async () => {
    const metrics = new InMemoryMetrics();
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "m2"),
      metrics,
    });
    await adapter.preload([]);
    adapter.writeJson("new.meta.json", { indexes: [] });
    await adapter.persist();
    const commits = metrics.snapshot().filter((s) => s.name === "gitstore.commit");
    expect(commits.reduce((sum, c) => sum + c.value, 0)).toBe(1);
    await adapter.close();
  });

  it("backpressure: persist() rejects when commit queue is full", async () => {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "m3"),
      maxPendingWrites: 1,
    });
    await adapter.preload([]);
    adapter.writeJson("a.meta.json", { v: 1 });
    adapter.writeJson("b.meta.json", { v: 2 });
    const [p1] = [adapter.persist()];
    adapter.writeJson("c.meta.json", { v: 3 });
    await expect(adapter.persist()).rejects.toMatchObject({ code: "BACKPRESSURE" });
    await p1;
    await adapter.persist();
    await adapter.close();
  });

  it("close() is idempotent", async () => {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "m4"),
    });
    await adapter.preload([]);
    await adapter.close();
    await adapter.close();
    await expect(adapter.preload(["c.meta.json"])).rejects.toMatchObject({ code: "ADAPTER_CLOSED" });
  });

  it("close() removes the lock file", async () => {
    const dir = join(cacheRoot, "m5");
    const adapter = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dir });
    await adapter.preload([]);
    adapter.writeJson("x.meta.json", { v: 1 });
    await adapter.persist();
    await adapter.close();
    const { access } = await import("node:fs/promises");
    await expect(access(join(dir, ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
