import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGit } from "../../src/core/git.js";
import { GitStoreAdapter } from "../../src/index.js";
import { makeFixtureBareRepo, type Fixture } from "../fixtures/make-bare-repo.js";

describe("P3-11: refresh() with SHA-pinned refs", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: { "x.docs.json": [{ _id: "1" }] },
      indexFiles: { "x.meta.json": { indexes: [] } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-p3-11-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("refresh() with contentRef pinned to a SHA throws INVALID_CONFIG", async () => {
    const dirV1 = join(cacheRoot, "prime");
    const primer = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dirV1 });
    await primer.preload([]);
    const sha = (await runGit(["rev-parse", "HEAD"], { cwd: join(dirV1, "content") })).stdout.trim();
    await primer.close();

    const pinned = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "pinned"),
      contentRef: sha,
    });
    await pinned.preload(["x.docs.json"]);
    await expect(pinned.refresh()).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await pinned.close();
  });
});

describe("P3-12: two adapters sharing the same localCacheDir", () => {
  let fixture: Fixture;
  let cacheRoot: string;
  let sharedDir: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: { "m.docs.json": [{ _id: "1", v: "seed" }] },
      indexFiles: { "m.meta.json": { indexes: [] } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-p3-12-"));
    sharedDir = join(cacheRoot, "shared");
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("persists from two adapters on the same cacheDir serialize via flock", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: sharedDir });
    const b = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: sharedDir });
    await a.preload([]);
    await b.preload([]);

    a.writeJson("m.meta.json", { indexes: [], who: "a" });
    b.writeJson("m.meta.json", { indexes: [], who: "b" });

    const [r1, r2] = await Promise.allSettled([a.persist(), b.persist()]);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");

    const log = await runGit(
      ["log", "--format=%s", "-n", "5", "HEAD"],
      { cwd: join(sharedDir, "index") },
    );
    const lines = log.stdout.trim().split("\n");
    const persistCount = lines.filter((l) => l.startsWith("js-git-store:")).length;
    expect(persistCount).toBeGreaterThanOrEqual(1);

    await a.close();
    await b.close();
  });

  it("second adapter sees first adapter's persisted change after preload", async () => {
    const dir = join(cacheRoot, "visibility");
    const writer = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dir });
    await writer.preload([]);
    writer.writeJson("m.meta.json", { indexes: [], via: "writer" });
    await writer.persist();

    const reader = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dir });
    await reader.preload(["m.meta.json"]);
    expect(reader.readJson<{ via?: string }>("m.meta.json")?.via).toBe("writer");

    await writer.close();
    await reader.close();
  });
});

describe("P3-19: cacheEntryCount public", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: { "c.docs.json": [{ _id: "1" }] },
      indexFiles: { "c.meta.json": { indexes: [] } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-p3-19-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("reports the number of cached entries", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "c1") });
    await a.preload([]);
    expect(a.cacheEntryCount()).toBe(0);
    await a.preload(["c.docs.json", "c.meta.json"]);
    expect(a.cacheEntryCount()).toBe(2);
    a.writeJson("extra.meta.json", { v: 1 });
    expect(a.cacheEntryCount()).toBe(3);
    a.invalidate("c.meta.json");
    expect(a.cacheEntryCount()).toBe(2);
    await a.close();
  });
});
