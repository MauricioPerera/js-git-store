import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitStoreAdapter } from "../../src/index.js";
import { makeFixtureBareRepo, type Fixture } from "../fixtures/make-bare-repo.js";

describe("P0-1: authBase not required for cached clones", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: { "x.docs.json": [{ _id: "1" }] },
      indexFiles: { "x.meta.json": { indexes: [] } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-p0-1-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("after initial clone, a new instance with unset authEnvVar can preload index files", async () => {
    const dir = join(cacheRoot, "p1");
    delete process.env["P0_AUTH_NONE"];
    const primer = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dir });
    await primer.preload([]);
    await primer.close();

    const stale = new GitStoreAdapter({
      repoUrl: fixture.fileUrl, localCacheDir: dir, authEnvVar: "P0_AUTH_NONE",
    });
    await expect(stale.preload(["x.meta.json"])).resolves.toBeUndefined();
    expect(stale.readJson("x.meta.json")).toEqual({ indexes: [] });
    await stale.close();
  });

  it("preload(content-file) with unset authEnvVar still throws AUTH_MISSING", async () => {
    const dir = join(cacheRoot, "p2");
    delete process.env["P0_AUTH_NONE2"];
    const primer = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dir });
    await primer.preload([]);
    await primer.close();
    const stale = new GitStoreAdapter({
      repoUrl: fixture.fileUrl, localCacheDir: dir, authEnvVar: "P0_AUTH_NONE2",
    });
    await expect(stale.preload(["x.docs.json"])).rejects.toMatchObject({ code: "AUTH_MISSING" });
    await stale.close();
  });
});

describe("P0-2: heavy regex with /g flag is stripped", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: { "big.docs.json": [{ _id: "1" }] },
      indexFiles: { "big.meta.json": { indexes: [] } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-p0-2-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("router with /g heavy regex routes deterministically across repeated calls", async () => {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "g1"),
      heavyFileRegex: /\.(bin|docs\.json)$/g,
    });
    await adapter.preload(["big.docs.json", "big.meta.json", "big.docs.json", "big.meta.json"]);
    expect(adapter.readJson("big.docs.json")).toEqual([{ _id: "1" }]);
    expect(adapter.readJson("big.meta.json")).toEqual({ indexes: [] });
    await adapter.close();
  });
});

describe("P0-4: config validation", () => {
  const base = { repoUrl: "file:///dev/null", localCacheDir: "/tmp/x" };

  function mustReject(fn: () => unknown, code: string): void {
    let err: unknown;
    try { fn(); } catch (e) { err = e; }
    expect((err as { code?: string } | undefined)?.code).toBe(code);
  }

  it("rejects negative maxCacheBytes", () => {
    mustReject(() => new GitStoreAdapter({ ...base, maxCacheBytes: -1 }), "INVALID_CONFIG");
  });

  it("rejects zero gitTimeoutMs", () => {
    mustReject(() => new GitStoreAdapter({ ...base, gitTimeoutMs: 0 }), "INVALID_CONFIG");
  });

  it("rejects negative gcIntervalMs", () => {
    mustReject(() => new GitStoreAdapter({ ...base, gcIntervalMs: -100 }), "INVALID_CONFIG");
  });

  it("rejects negative lockTimeoutMs", () => {
    mustReject(() => new GitStoreAdapter({ ...base, lockTimeoutMs: -1 }), "INVALID_CONFIG");
  });

  it("rejects empty author fields", () => {
    mustReject(() => new GitStoreAdapter({ ...base, author: { name: "", email: "x@y" } }), "INVALID_CONFIG");
    mustReject(() => new GitStoreAdapter({ ...base, author: { name: "a", email: "" } }), "INVALID_CONFIG");
  });

  it("INVALID_CONFIG for missing repoUrl", () => {
    mustReject(() => new GitStoreAdapter({ repoUrl: "", localCacheDir: "/tmp/x" }), "INVALID_CONFIG");
  });
});

describe("P0-3: refresh() refuses to discard unpushed commits", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: { "a.docs.json": [{ _id: "1", v: "seed" }] },
      indexFiles: { "a.meta.json": { indexes: [] } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-p0-3-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("refresh() without force throws CONCURRENT_WRITE when local commits exist", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "r1") });
    await a.preload([]);
    a.writeJson("a.meta.json", { indexes: [{ field: "x" }] });
    await a.persist();
    await expect(a.refresh()).rejects.toMatchObject({ code: "CONCURRENT_WRITE" });
    await a.close();
  });

  it("refresh({ force: true }) overrides the check and discards local commits", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "r2") });
    await a.preload([]);
    a.writeJson("a.meta.json", { indexes: [{ field: "will-be-discarded" }] });
    await a.persist();
    await expect(a.refresh({ force: true })).resolves.toBeUndefined();
    await a.preload(["a.meta.json"]);
    expect(adapter_field_count(a.readJson("a.meta.json"))).toBe(0);
    await a.close();
  });
});

function adapter_field_count(meta: unknown): number {
  if (typeof meta !== "object" || meta === null) return -1;
  const ix = (meta as { indexes?: unknown }).indexes;
  return Array.isArray(ix) ? ix.length : -1;
}
