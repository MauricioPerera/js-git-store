import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGit } from "../../src/core/git.js";
import { GitStoreAdapter, GitStoreError } from "../../src/index.js";
import { makeFixtureBareRepo, type Fixture } from "../fixtures/make-bare-repo.js";

describe("ADAPTER_CLOSED error code", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo();
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-c1-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("post-close operations surface ADAPTER_CLOSED, not GIT_COMMAND_FAILED", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "x1") });
    await a.preload([]);
    await a.close();
    await expect(a.preload(["users.meta.json"])).rejects.toMatchObject({ code: "ADAPTER_CLOSED" });
    await expect(a.persist()).rejects.toMatchObject({ code: "ADAPTER_CLOSED" });
    await expect(a.push()).rejects.toMatchObject({ code: "ADAPTER_CLOSED" });
    await expect(a.refresh()).rejects.toMatchObject({ code: "ADAPTER_CLOSED" });
  });
});

describe("LRU eviction: reads touch recency", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: {
        "a.docs.json": [{ _id: "a", body: "x".repeat(200) }],
        "b.docs.json": [{ _id: "b", body: "y".repeat(200) }],
        "c.docs.json": [{ _id: "c", body: "z".repeat(200) }],
      },
      indexFiles: {},
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-lru-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("reading a entry protects it from eviction when a newer one arrives", async () => {
    const a = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "lru"),
      maxCacheBytes: 500,
    });
    await a.preload(["a.docs.json", "b.docs.json"]);
    a.readJson("a.docs.json");
    await a.preload(["c.docs.json"]);
    expect(a.readJson("a.docs.json")).not.toBeNull();
    expect(a.readJson("b.docs.json")).toBeNull();
    await a.close();
  });
});

describe("indexDepth config", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo();
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-idx-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("indexDepth=0 produces a full clone (unshallow)", async () => {
    const dir = join(cacheRoot, "full");
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dir, indexDepth: 0 });
    await a.preload([]);
    const shallow = await runGit(["rev-parse", "--is-shallow-repository"], { cwd: join(dir, "index") });
    expect(shallow.stdout.trim()).toBe("false");
    await a.close();
  });

  it("default indexDepth=1 produces a shallow clone", async () => {
    const dir = join(cacheRoot, "shallow");
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dir });
    await a.preload([]);
    const shallow = await runGit(["rev-parse", "--is-shallow-repository"], { cwd: join(dir, "index") });
    expect(shallow.stdout.trim()).toBe("true");
    await a.close();
  });
});

describe("isMissing narrowed", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo();
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-miss-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("a truly-missing file returns null (miss path, not error)", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "m1") });
    await a.preload(["nope.docs.json"]);
    expect(a.readJson("nope.docs.json")).toBeNull();
    await a.close();
  });
});

describe("refresh() picks up external pushes", () => {
  let fixture: Fixture;
  let cacheRoot: string;
  let seedDir: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: { "articles.docs.json": [{ _id: "1", title: "v1" }] },
      indexFiles: { "articles.meta.json": { indexes: [], version: 1 } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-ref-"));
    seedDir = await mkdtemp(join(tmpdir(), "gls-refseed-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(seedDir, { recursive: true, force: true });
  });

  it("after another writer pushes, refresh() drops clean cache and re-reads see the new commit", async () => {
    const reader = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "r1") });
    await reader.preload(["articles.docs.json", "articles.meta.json"]);
    const v1 = reader.readJson("articles.docs.json") as Array<{ title: string }>;
    expect(v1[0]?.title).toBe("v1");

    const writer = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "w1"),
      pushOnPersist: true,
    });
    await writer.preload(["articles.docs.json"]);
    writer.writeJson("articles.docs.json", [{ _id: "1", title: "v2" }]);
    await writer.persist();
    await writer.close();

    expect((reader.readJson("articles.docs.json") as Array<{ title: string }>)[0]?.title).toBe("v1");

    await reader.refresh();
    await reader.preload(["articles.docs.json"]);
    expect((reader.readJson("articles.docs.json") as Array<{ title: string }>)[0]?.title).toBe("v2");
    await reader.close();
  });

  it("refresh() preserves dirty entries", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "r2") });
    await a.preload([]);
    a.writeJson("staged.meta.json", { v: 1 });
    await a.refresh();
    expect(a.readJson("staged.meta.json")).toEqual({ v: 1 });
    await a.close();
  });
});

describe("dead-code removal sanity", () => {
  it("blob-fetch.ts no longer exists", async () => {
    const { stat } = await import("node:fs/promises");
    await expect(stat(join(process.cwd(), "src/core/blob-fetch.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// Keep unused var lint happy
void GitStoreError;
void writeFile;
