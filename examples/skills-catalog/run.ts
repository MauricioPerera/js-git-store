/**
 * Example: migrate a skills catalog to GitStoreAdapter + real DocStore.
 *
 * Builds a local bare git repo pre-seeded with skills, docs, prompts, templates.
 * Demonstrates reading with queries, creating an index, inserting a new skill,
 * and committing — all via the upstream js-doc-store API.
 *
 * Run: npm run example:skills
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "js-doc-store";
import { GitStoreAdapter } from "../../src/index.js";
import { makeFixtureBareRepo } from "../../tests/fixtures/make-bare-repo.js";

const { DocStore } = pkg as { DocStore: new (a: unknown) => DocStoreInstance };

interface DocStoreInstance {
  collection(name: string): {
    createIndex: (field: string, opts?: { unique?: boolean }) => void;
    insert: (doc: Record<string, unknown>) => Record<string, unknown>;
    findOne: (filter: Record<string, unknown>) => Record<string, unknown> | null;
    find: (filter?: Record<string, unknown>) => { toArray: () => Record<string, unknown>[]; count: () => number };
  };
  flush: () => void;
}

async function main(): Promise<void> {
  const fixture = await makeFixtureBareRepo({
    contentFiles: {
      "skills.docs.json": [
        { _id: "bash", name: "bash", description: "run shell commands" },
        { _id: "curl", name: "curl", description: "http fetch" },
      ],
      "docs.docs.json": [{ _id: "readme", title: "readme", body: "hello" }],
      "prompts.docs.json": [{ _id: "greet", text: "hello {name}" }],
      "templates.docs.json": [{ _id: "blank", body: "" }],
    },
    indexFiles: {
      "skills.meta.json": { indexes: [] },
      "docs.meta.json": { indexes: [] },
      "prompts.meta.json": { indexes: [] },
      "templates.meta.json": { indexes: [] },
    },
  });

  const cache = await mkdtemp(join(tmpdir(), "skills-ex-"));
  const adapter = new GitStoreAdapter({
    repoUrl: fixture.fileUrl,
    localCacheDir: cache,
    author: { name: "example", email: "example@local" },
  });

  try {
    const categories = ["skills", "docs", "prompts", "templates"];
    const files: string[] = [];
    for (const c of categories) files.push(`${c}.docs.json`, `${c}.meta.json`);
    await adapter.preload(files);

    const db = new DocStore(adapter);
    for (const c of categories) {
      const count = db.collection(c).find({}).count();
      console.log(`  ${c}: ${count} entries`);
    }

    const skills = db.collection("skills");
    skills.createIndex("name", { unique: true });
    skills.insert({
      _id: "semantic-search",
      name: "semantic-search",
      when_to_use: "similarity search over documents",
      description: "wraps js-vector-store",
      entry: "run.sh",
    });
    db.flush();
    await adapter.persist();
    await adapter.push();
    console.log(`inserted semantic-search; skills now has ${skills.find({}).count()} entries`);

    const hit = skills.findOne({ name: "semantic-search" });
    if (!hit) throw new Error("semantic-search not persisted");
    console.log("round-trip OK");

    const cacheB = await mkdtemp(join(tmpdir(), "skills-ex-b-"));
    const b = new GitStoreAdapter({ repoUrl: fixture.fileUrl, localCacheDir: cacheB });
    try {
      await b.preload(["skills.docs.json", "skills.meta.json"]);
      const dbB = new DocStore(b);
      const rehydrated = dbB.collection("skills").findOne({ name: "semantic-search" });
      console.log(`second reader sees it: ${rehydrated ? "yes" : "no"}`);
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
