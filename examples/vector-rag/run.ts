/**
 * Example: git-backed vector store.
 * Writes a tiny set of vectors and bytes into a bare git repo, persists them,
 * and verifies round-trip via a fresh adapter instance.
 *
 * Run: npm run example:vector
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitStoreAdapter } from "../../src/index.js";
import { makeFixtureBareRepo } from "../../tests/fixtures/make-bare-repo.js";

async function main(): Promise<void> {
  const fixture = await makeFixtureBareRepo({
    contentFiles: {},
    indexFiles: {},
  });
  const cache = await mkdtemp(join(tmpdir(), "vec-ex-"));
  const adapter = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: cache });

  try {
    await adapter.preload([]);
    const dim = 4;
    const vectors = new Float32Array([
      0.1, 0.2, 0.3, 0.4,
      0.5, 0.6, 0.7, 0.8,
      0.9, 1.0, 1.1, 1.2,
    ]);
    adapter.writeBin("articles.bin", new Uint8Array(vectors.buffer));
    adapter.writeJson("articles.json", { dim, count: 3, names: ["a", "b", "c"] });
    await adapter.persist();
    await adapter.push();
    console.log(`persisted ${vectors.length / dim} vectors into git`);

    const cacheB = await mkdtemp(join(tmpdir(), "vec-ex-b-"));
    const b = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: cacheB });
    try {
      await b.preload(["articles.bin", "articles.json"]);
      const ab = b.readBin("articles.bin");
      const meta = b.readJson("articles.json") as { dim: number; count: number };
      if (!ab) throw new Error("bin blob not found in second reader");
      const hydrated = new Float32Array(ab, 0, meta.dim * meta.count);
      console.log(`second reader hydrated ${hydrated.length / meta.dim} vectors`);
      console.log(`first row: [${Array.from(hydrated.slice(0, meta.dim)).join(", ")}]`);
    } finally {
      await b.close();
      await rm(cacheB, { recursive: true, force: true });
    }
  } finally {
    await adapter.close();
    await rm(cache, { recursive: true, force: true });
    await fixture.cleanup();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
