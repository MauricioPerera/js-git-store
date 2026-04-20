import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitStoreAdapter, InMemoryMetrics } from "../../src/index.js";
import { makeFixtureBareRepo, type Fixture } from "../fixtures/make-bare-repo.js";

describe("v1.0.1 — path traversal rejection (adapter surface)", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo();
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-v6t-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("writeJson rejects ../ escapes", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "t1") });
    let err: unknown;
    try { a.writeJson("../../evil.meta.json", { x: 1 }); } catch (e) { err = e; }
    expect((err as { code?: string })?.code).toBe("INVALID_CONFIG");
    await a.close();
  });

  it("preload rejects absolute paths", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "t2") });
    await expect(a.preload(["/etc/passwd"])).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await a.close();
  });

  it("delete rejects drive-letter paths", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "t3") });
    expect(() => a.delete("C:/Windows/system.json")).toThrow(/INVALID_CONFIG|drive-letter/);
    await a.close();
  });

  it("no file is created outside the cache dir even when the caller is hostile", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "t4") });
    await a.preload([]);
    try { a.writeJson("../../../pwned.docs.json", { x: 1 }); } catch {}
    try { a.writeBin("../../../pwned.bin", new Uint8Array([1])); } catch {}
    // Nothing should exist above cacheRoot
    await expect(stat(join(cacheRoot, "..", "pwned.docs.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await a.close();
  });
});

describe("v1.0.1 — parallel preload + in-flight coalescing", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: {
        "a.docs.json": [{ _id: "a" }],
        "b.docs.json": [{ _id: "b" }],
        "c.docs.json": [{ _id: "c" }],
      },
      indexFiles: {
        "a.meta.json": { indexes: [] },
        "b.meta.json": { indexes: [] },
        "c.meta.json": { indexes: [] },
      },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-v6p-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("preload is parallel (wall-clock < sum of individual fetches)", async () => {
    const metrics = new InMemoryMetrics();
    const a = new GitStoreAdapter({
      repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "p1"), metrics,
    });
    await a.preload([]);
    const t0 = Date.now();
    await a.preload(["a.docs.json", "b.docs.json", "c.docs.json"]);
    const total = Date.now() - t0;
    expect(a.readJson("a.docs.json")).not.toBeNull();
    expect(a.readJson("b.docs.json")).not.toBeNull();
    expect(a.readJson("c.docs.json")).not.toBeNull();
    const hist = metrics.snapshot().find((s) => s.name === "gitstore.blob.fetch.ms" && s.kind === "histogram");
    expect(hist?.count).toBe(3);
    const sumIndividual = hist?.value ?? 0;
    expect(total).toBeLessThan(sumIndividual + 500);
    await a.close();
  });

  it("two concurrent preloads of the same filename share a single fetch (coalescing)", async () => {
    const metrics = new InMemoryMetrics();
    const a = new GitStoreAdapter({
      repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "p2"), metrics,
    });
    await a.preload([]);
    await Promise.all([a.preload(["a.docs.json"]), a.preload(["a.docs.json"])]);
    const okCount = metrics.snapshot()
      .filter((s) => s.name === "gitstore.blob.fetch" && s.labels?.["result"] === "ok")
      .reduce((n, s) => n + s.value, 0);
    expect(okCount).toBe(1);
    await a.close();
  });
});

describe("v1.0.1 — batch git add + persist metrics", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo();
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-v6b-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("persist emits gitstore.persist counter + gitstore.persist.ms histogram", async () => {
    const metrics = new InMemoryMetrics();
    const a = new GitStoreAdapter({
      repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "m1"), metrics,
    });
    await a.preload([]);
    a.writeJson("a.meta.json", { v: 1 });
    a.writeJson("b.meta.json", { v: 2 });
    a.writeJson("c.meta.json", { v: 3 });
    await a.persist();
    const counter = metrics.snapshot().find((s) => s.name === "gitstore.persist");
    const hist = metrics.snapshot().find((s) => s.name === "gitstore.persist.ms");
    expect(counter?.value).toBe(1);
    expect(hist?.count).toBe(1);
    await a.close();
  });
});

describe("v1.0.1 — readBinShared zero-copy variant", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: { "blob.bin": Buffer.from([10, 20, 30, 40]) },
      indexFiles: { "blob.json": { dim: 4 } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-v6s-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("readBinShared returns a Uint8Array view of the cached bytes", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "s1") });
    await a.preload(["blob.bin"]);
    const view = a.readBinShared("blob.bin");
    expect(view).not.toBeNull();
    expect(Array.from(view!)).toEqual([10, 20, 30, 40]);
    const view2 = a.readBinShared("blob.bin");
    expect(view2).not.toBeNull();
    expect(view!.buffer).toBe(view2!.buffer);
    await a.close();
  });

  it("readBinShared returns null for missing or deleted files", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "s2") });
    await a.preload([]);
    expect(a.readBinShared("missing.bin")).toBeNull();
    a.writeBin("x.bin", new Uint8Array([1]));
    a.delete("x.bin");
    expect(a.readBinShared("x.bin")).toBeNull();
    await a.close();
  });
});
