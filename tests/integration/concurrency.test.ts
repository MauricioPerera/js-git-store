import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitStoreAdapter } from "../../src/index.js";
import { makeFixtureBareRepo, type Fixture } from "../fixtures/make-bare-repo.js";

describe("concurrency — in-process serialization", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo();
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-conc-"));
  });

  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("parallel preload + persist pairs serialize correctly", async () => {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "c1"),
    });
    await adapter.preload([]);
    const runs = Array.from({ length: 5 }, (_, i) => (async () => {
      adapter.writeJson(`col${i}.meta.json`, { indexes: [], idx: i });
      await adapter.persist();
    })());
    await Promise.all(runs);
    for (let i = 0; i < 5; i++) {
      expect(adapter.readJson(`col${i}.meta.json`)).toMatchObject({ idx: i });
    }
    await adapter.close();
  });

  it("consecutive writes in one instance preserve last-writer-wins semantics", async () => {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "c2"),
    });
    await adapter.preload([]);
    adapter.writeJson("doc.meta.json", { v: 1 });
    await adapter.persist();
    adapter.writeJson("doc.meta.json", { v: 2 });
    await adapter.persist();
    expect(adapter.readJson("doc.meta.json")).toEqual({ v: 2 });
    await adapter.close();
  });
});
