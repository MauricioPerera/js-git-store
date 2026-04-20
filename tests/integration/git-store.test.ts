import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pkg from "js-doc-store";
import { GitStoreAdapter } from "../../src/index.js";
import { makeFixtureBareRepo, type Fixture } from "../fixtures/make-bare-repo.js";

const { DocStore } = pkg as { DocStore: new (a: unknown) => DocStoreInstance };

interface DocStoreInstance {
  collection(name: string): {
    createIndex: (field: string, opts?: { unique?: boolean; type?: string }) => void;
    insert: (doc: Record<string, unknown>) => Record<string, unknown>;
    findOne: (filter: Record<string, unknown>) => Record<string, unknown> | null;
    find: (filter?: Record<string, unknown>) => { toArray: () => Record<string, unknown>[]; count: () => number };
    count: () => number;
  };
  flush: () => void;
}

describe("GitStoreAdapter + real DocStore", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: {
        "users.docs.json": [
          { _id: "u1", email: "a@example.com", name: "Alice" },
          { _id: "u2", email: "b@example.com", name: "Bob" },
        ],
      },
      indexFiles: {
        "users.meta.json": { indexes: [] },
      },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-ds-"));
  });

  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("preload + DocStore.find returns seeded docs", async () => {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "a1"),
    });
    await adapter.preload(["users.docs.json", "users.meta.json"]);
    const db = new DocStore(adapter);
    const users = db.collection("users").find({}).toArray();
    expect(users).toHaveLength(2);
    expect(users.map((u) => u["email"]).sort()).toEqual(["a@example.com", "b@example.com"]);
    await adapter.close();
  });

  it("insert + flush + persist creates commits on both branches", async () => {
    const dir = join(cacheRoot, "a2");
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: dir,
    });
    await adapter.preload(["users.docs.json", "users.meta.json"]);
    const db = new DocStore(adapter);
    const col = db.collection("users");
    col.createIndex("email", { unique: true });
    col.insert({ _id: "u3", email: "c@example.com", name: "Carol" });
    db.flush();
    await adapter.persist();

    const docsRaw = await readFile(join(dir, "content", "users.docs.json"), "utf8");
    const docs = JSON.parse(docsRaw) as unknown[];
    expect(docs).toHaveLength(3);

    const metaRaw = await readFile(join(dir, "index", "users.meta.json"), "utf8");
    const meta = JSON.parse(metaRaw) as { indexes: Array<{ field: string }> };
    expect(meta.indexes.map((i) => i.field)).toContain("email");
    await adapter.close();
  });

  it("a second adapter instance sees the committed inserts", async () => {
    const dirA = join(cacheRoot, "a3a");
    const dirB = join(cacheRoot, "a3b");
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dirA, pushOnPersist: true });
    await a.preload(["users.docs.json", "users.meta.json"]);
    const dbA = new DocStore(a);
    dbA.collection("users").insert({ _id: "u9", email: "z@example.com", name: "Zoe" });
    dbA.flush();
    await a.persist();
    await a.close();

    const b = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dirB });
    await b.preload(["users.docs.json", "users.meta.json"]);
    const dbB = new DocStore(b);
    const all = dbB.collection("users").find({}).toArray();
    expect(all.map((u) => u["_id"])).toContain("u9");
    await b.close();
  });

  it("never-preloaded file returns null (upstream contract)", async () => {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "a4"),
    });
    await adapter.preload([]);
    expect(adapter.readJson("does.not.exist.json")).toBeNull();
    expect(adapter.readBin("does.not.exist.bin")).toBeNull();
    await adapter.close();
  });

  it("write then read within the same instance is sync-visible", async () => {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "a5"),
    });
    await adapter.preload([]);
    adapter.writeJson("foo.meta.json", { indexes: [{ field: "x" }] });
    expect(adapter.readJson("foo.meta.json")).toEqual({ indexes: [{ field: "x" }] });
    await adapter.close();
  });

  it("delete marks file for removal and persist deletes it", async () => {
    const dir = join(cacheRoot, "a6");
    const adapter = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dir });
    await adapter.preload(["users.meta.json"]);
    adapter.writeJson("tmp.meta.json", { tmp: true });
    await adapter.persist();
    adapter.delete("tmp.meta.json");
    await adapter.persist();
    await expect(readFile(join(dir, "index", "tmp.meta.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await adapter.close();
  });
});

describe("GitStoreAdapter — push concurrency + pin-to-SHA", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: {
        "users.docs.json": [{ _id: "u1", email: "a@example.com", name: "Alice" }],
      },
      indexFiles: { "users.meta.json": { indexes: [] } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-conc2-"));
  });

  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("non-fast-forward push surfaces CONCURRENT_WRITE", async () => {
    const a = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "p1a") });
    const b = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "p1b") });
    await a.preload(["users.docs.json", "users.meta.json"]);
    await b.preload(["users.docs.json", "users.meta.json"]);
    a.writeJson("users.docs.json", [{ _id: "u1", name: "from A" }]);
    b.writeJson("users.docs.json", [{ _id: "u1", name: "from B" }]);
    await a.persist();
    await a.push();
    await b.persist();
    await expect(b.push()).rejects.toMatchObject({ code: "CONCURRENT_WRITE" });
    await a.close();
    await b.close();
  });

  it("pin-to-SHA reads the repo state as of that commit", async () => {
    const dirV1 = join(cacheRoot, "sha1");
    const pusher = new GitStoreAdapter({
      repoUrl: fixture.fileUrl, localCacheDir: dirV1, pushOnPersist: true,
    });
    await pusher.preload(["users.docs.json", "users.meta.json"]);
    pusher.writeJson("users.docs.json", [{ _id: "u1", name: "v1-snapshot" }]);
    await pusher.persist();
    const { runGit } = await import("../../src/core/git.js");
    const sha = (await runGit(["rev-parse", "HEAD"], { cwd: join(dirV1, "content") })).stdout.trim();
    pusher.writeJson("users.docs.json", [{ _id: "u1", name: "v2-after" }]);
    await pusher.persist();
    await pusher.close();

    const pinned = new GitStoreAdapter({
      repoUrl: fixture.fileUrl, localCacheDir: join(cacheRoot, "sha2"), contentRef: sha,
    });
    await pinned.preload(["users.docs.json"]);
    const docs = pinned.readJson("users.docs.json") as Array<{ name: string }>;
    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0]?.name).toBe("v1-snapshot");
    await pinned.close();
  });
});

describe("GitStoreAdapter errors", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo();
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-err-"));
  });

  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("non-existent indexRef → BRANCH_NOT_FOUND on preload", async () => {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      indexRef: "not-a-branch",
      localCacheDir: join(cacheRoot, "e1"),
    });
    await expect(adapter.preload(["users.meta.json"])).rejects.toMatchObject({
      code: "BRANCH_NOT_FOUND",
    });
    await adapter.close();
  });

  it("missing auth env var → AUTH_MISSING", async () => {
    delete process.env["GLS_TOKEN_DOES_NOT_EXIST"];
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "e2"),
      authEnvVar: "GLS_TOKEN_DOES_NOT_EXIST",
    });
    await expect(adapter.preload([])).rejects.toMatchObject({ code: "AUTH_MISSING" });
    await adapter.close();
  });
});
