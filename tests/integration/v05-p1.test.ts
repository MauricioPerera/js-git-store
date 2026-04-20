import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitStoreAdapter } from "../../src/index.js";
import { makeFixtureBareRepo, type Fixture } from "../fixtures/make-bare-repo.js";

describe("P1-1: Symbol.asyncDispose", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo();
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-p1-1-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("await using disposes the adapter automatically", async () => {
    const dir = join(cacheRoot, "d1");
    {
      const adapter = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dir });
      await adapter.preload([]);
      adapter.writeJson("scoped.meta.json", { scoped: true });
      await adapter.persist();
      await adapter[Symbol.asyncDispose]();
    }
    const entries = await readdir(dir);
    expect(entries).not.toContain(".lock");
  });

  it("double-dispose is safe (close is idempotent)", async () => {
    const adapter = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "d2") });
    await adapter.preload([]);
    await adapter[Symbol.asyncDispose]();
    await adapter[Symbol.asyncDispose]();
    await adapter.close();
  });
});

describe("P1-2: readJson is generic", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: {},
      indexFiles: { "users.meta.json": { indexes: [{ field: "email", type: "hash" }] } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-p1-2-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("returns the inferred T when provided", async () => {
    interface Meta { indexes: Array<{ field: string; type: string }> }
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "g1") });
    await a.preload(["users.meta.json"]);
    const meta = a.readJson<Meta>("users.meta.json");
    expect(meta?.indexes[0]?.field).toBe("email");
    await a.close();
  });

  it("defaults to unknown when no T is specified (back-compat)", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "g2") });
    await a.preload(["users.meta.json"]);
    const raw: unknown = a.readJson("users.meta.json");
    expect(raw).not.toBeNull();
    await a.close();
  });
});

describe("P1-3: push() is serialized under flock", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: { "doc.docs.json": [{ _id: "1" }] },
      indexFiles: { "doc.meta.json": { indexes: [] } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-p1-3-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("persist + explicit push serialize via queue + lock (no interleaving)", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "p1") });
    await a.preload([]);
    a.writeJson("doc.meta.json", { indexes: [{ v: 1 }] });
    const persistP = a.persist();
    const pushP = a.push();
    await persistP;
    await pushP;
    await a.close();
  });

  it("push() on a closed adapter throws ADAPTER_CLOSED", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "p2") });
    await a.preload([]);
    await a.close();
    await expect(a.push()).rejects.toMatchObject({ code: "ADAPTER_CLOSED" });
  });
});
