import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGit } from "../../src/core/git.js";
import { GitStoreAdapter } from "../../src/index.js";
import { makeFixtureBareRepo, type Fixture } from "../fixtures/make-bare-repo.js";

describe("configs → -c k=v propagation", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "gls-cfg-"));
    await runGit(["init", "-b", "main", tmp], { cwd: tmp });
    await writeFile(join(tmp, "a"), "x", "utf8");
    await runGit(["add", "a"], { cwd: tmp });
  });

  afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

  it("inline user.email via configs is honored by the commit", async () => {
    await runGit(["commit", "-m", "m"], {
      cwd: tmp,
      configs: { "user.email": "cfg@test", "user.name": "cfg-name" },
    });
    const log = await runGit(["log", "-1", "--format=%ae|%an"], { cwd: tmp });
    expect(log.stdout.trim()).toBe("cfg@test|cfg-name");
  });
});

describe("maxCacheBytes eviction", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: {
        "a.docs.json": Array.from({ length: 50 }, (_, i) => ({ _id: `a${i}`, body: "x".repeat(200) })),
        "b.docs.json": Array.from({ length: 50 }, (_, i) => ({ _id: `b${i}`, body: "y".repeat(200) })),
      },
      indexFiles: {
        "a.meta.json": { indexes: [] },
        "b.meta.json": { indexes: [] },
      },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-evict-"));
  });

  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("cache stays under the configured cap", async () => {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "e1"),
      maxCacheBytes: 5_000,
    });
    await adapter.preload(["a.meta.json", "b.meta.json", "a.docs.json", "b.docs.json"]);
    expect(adapter.cacheBytes()).toBeLessThanOrEqual(5_000);
    await adapter.close();
  });

  it("dirty entries are never evicted even past the cap", async () => {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "e2"),
      maxCacheBytes: 100,
    });
    await adapter.preload([]);
    adapter.writeJson("dirty.meta.json", { v: "preserve-me" });
    await adapter.preload(["a.docs.json", "b.docs.json"]);
    expect(adapter.readJson("dirty.meta.json")).toEqual({ v: "preserve-me" });
    await adapter.close();
  });
});

describe("invalidate(filename)", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: { "x.docs.json": [{ _id: "1" }] },
      indexFiles: { "x.meta.json": { indexes: [] } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-inv-"));
  });

  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("removes clean entries from the cache", async () => {
    const adapter = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "i1") });
    await adapter.preload(["x.docs.json", "x.meta.json"]);
    expect(adapter.readJson("x.docs.json")).not.toBeNull();
    expect(adapter.invalidate("x.docs.json")).toBe(true);
    expect(adapter.readJson("x.docs.json")).toBeNull();
    await adapter.close();
  });

  it("refuses to evict dirty entries", async () => {
    const adapter = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "i2") });
    await adapter.preload([]);
    adapter.writeJson("pending.meta.json", { v: 1 });
    expect(adapter.invalidate("pending.meta.json")).toBe(false);
    expect(adapter.readJson("pending.meta.json")).toEqual({ v: 1 });
    await adapter.close();
  });
});

describe("BLOB_FETCH_TIMEOUT", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: { "big.docs.json": Array.from({ length: 2000 }, (_, i) => ({ _id: `b${i}`, body: "z".repeat(500) })) },
      indexFiles: { "big.meta.json": { indexes: [] } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-tout-"));
  });

  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("a tight timeout on a heavy-blob preload surfaces BLOB_FETCH_TIMEOUT", async () => {
    const dir = join(cacheRoot, "t1");
    const primer = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dir });
    await primer.preload([]);
    await primer.close();

    const tight = new GitStoreAdapter({
      repoUrl: fixture.fileUrl, localCacheDir: dir, gitTimeoutMs: 1,
    });
    const err = await tight.preload(["big.docs.json"]).catch((e: unknown) => e);
    expect(err).toBeDefined();
    expect((err as { name?: string; code?: string })?.name).toBe("GitStoreError");
    expect((err as { code?: string })?.code).toBe("BLOB_FETCH_TIMEOUT");
    await tight.close();
  });
});
