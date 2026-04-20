import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGit } from "../../src/core/git.js";
import { GitStoreAdapter, InMemoryMetrics } from "../../src/index.js";
import { makeFixtureBareRepo, type Fixture } from "../fixtures/make-bare-repo.js";

describe("gc()", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: { "a.docs.json": [{ _id: "1" }] },
      indexFiles: { "a.meta.json": { indexes: [] } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-gc-"));
  });

  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("gc() runs without error + preserves reachability", async () => {
    const metrics = new InMemoryMetrics();
    const dir = join(cacheRoot, "gc1");
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dir, metrics });
    await a.preload(["a.docs.json", "a.meta.json"]);
    a.writeJson("a.meta.json", { indexes: [{ field: "x" }] });
    await a.persist();
    await a.gc();
    await runGit(["fsck", "--full", "--strict"], { cwd: join(dir, "content") });
    await runGit(["fsck", "--full", "--strict"], { cwd: join(dir, "index") });
    expect(metrics.snapshot().find((s) => s.name === "gitstore.gc")?.value).toBe(1);
    const hist = metrics.snapshot().find((s) => s.name === "gitstore.gc.ms");
    expect(hist?.count).toBe(1);
    await a.close();
  });

  it("gcIntervalMs schedules background gc and close clears the timer", async () => {
    const metrics = new InMemoryMetrics();
    const a = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "gc2"),
      metrics,
      gcIntervalMs: 300,
    });
    await a.preload([]);
    await new Promise((r) => setTimeout(r, 1500));
    const gcBefore = metrics.snapshot().find((s) => s.name === "gitstore.gc")?.value ?? 0;
    expect(gcBefore).toBeGreaterThanOrEqual(1);
    await a.close();
    const gcSnap = metrics.snapshot().find((s) => s.name === "gitstore.gc")?.value ?? 0;
    await new Promise((r) => setTimeout(r, 1000));
    const gcAfter = metrics.snapshot().find((s) => s.name === "gitstore.gc")?.value ?? 0;
    expect(gcAfter).toBe(gcSnap);
  });
});

describe("graceful shutdown", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo();
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-gs-"));
  });

  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("close() during in-flight persist drains the queue before returning", async () => {
    const dir = join(cacheRoot, "gs1");
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dir });
    await a.preload([]);
    a.writeJson("a.meta.json", { v: 1 });
    a.writeJson("b.meta.json", { v: 2 });
    const inflight = a.persist();
    await a.close();
    await inflight;

    const aShow = await runGit(["show", "HEAD:a.meta.json"], { cwd: join(dir, "index") });
    const bShow = await runGit(["show", "HEAD:b.meta.json"], { cwd: join(dir, "index") });
    expect(JSON.parse(aShow.stdout)).toEqual({ v: 1 });
    expect(JSON.parse(bShow.stdout)).toEqual({ v: 2 });

    const entries = await readdir(dir);
    expect(entries).not.toContain(".lock");
  });

  it("close() is a no-op if already closed", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "gs2") });
    await a.preload([]);
    await a.close();
    await a.close();
    await a.close();
  });
});

// keep lint happy
void writeFile;
