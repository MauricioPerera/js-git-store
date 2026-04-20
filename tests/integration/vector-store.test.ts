import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitStoreAdapter } from "../../src/index.js";
import { makeFixtureBareRepo, type Fixture } from "../fixtures/make-bare-repo.js";

describe("GitStoreAdapter binary round-trip", () => {
  let fixture: Fixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await makeFixtureBareRepo({
      contentFiles: { "seed.bin": Buffer.from([1, 2, 3, 4, 5]) },
      indexFiles: { "seed.json": { dim: 5, count: 1 } },
    });
    cacheRoot = await mkdtemp(join(tmpdir(), "gls-vec-"));
  });

  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("readBin serves preloaded bytes", async () => {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "b1"),
    });
    await adapter.preload(["seed.bin", "seed.json"]);
    const ab = adapter.readBin("seed.bin");
    expect(ab).not.toBeNull();
    expect(new Uint8Array(ab!)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(adapter.readJson("seed.json")).toEqual({ dim: 5, count: 1 });
    await adapter.close();
  });

  it("writeBin + persist routes .bin to content branch", async () => {
    const dir = join(cacheRoot, "b2");
    const adapter = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: dir });
    await adapter.preload([]);
    const buf = new Uint8Array(new Float32Array([1, 2, 3]).buffer);
    adapter.writeBin("vectors.bin", buf);
    adapter.writeJson("vectors.json", { dim: 3 });
    await adapter.persist();

    const readBack = await readFile(join(dir, "content", "vectors.bin"));
    expect(new Float32Array(readBack.buffer, readBack.byteOffset, 3)).toEqual(new Float32Array([1, 2, 3]));
    const meta = JSON.parse(await readFile(join(dir, "index", "vectors.json"), "utf8")) as { dim: number };
    expect(meta.dim).toBe(3);
    await adapter.close();
  });

  it("ArrayBuffer input is accepted (not just Uint8Array)", async () => {
    const adapter = new GitStoreAdapter({
      repoUrl: fixture.fileUrl,
      localCacheDir: join(cacheRoot, "b3"),
    });
    await adapter.preload([]);
    const ab = new ArrayBuffer(4);
    new DataView(ab).setUint32(0, 0xdeadbeef);
    adapter.writeBin("x.bin", ab);
    const got = adapter.readBin("x.bin");
    expect(got).not.toBeNull();
    expect(new DataView(got!).getUint32(0)).toBe(0xdeadbeef);
    await adapter.close();
  });
});
