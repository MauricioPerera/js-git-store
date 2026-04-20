import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/core/git.js";

export interface Fixture {
  bareDir: string;
  fileUrl: string;
  cleanup: () => Promise<void>;
}

export interface FixtureOptions {
  /** Files to seed on contentRef (heavy files). Values are stringified JSON or Buffer. */
  contentFiles?: Record<string, unknown | Buffer>;
  /** Files to seed on indexRef (light files). Always JSON-serialized. */
  indexFiles?: Record<string, unknown>;
}

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@local",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@local",
};

/**
 * Spin up a local bare git repo with `main` + `index` branches pre-seeded with
 * files in the flat namespace js-doc-store / js-vector-store use.
 */
export async function makeFixtureBareRepo(opts: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "gls-fixture-"));
  const bareDir = join(root, "repo.git");
  const seedDir = join(root, "seed");
  await runGit(["init", "--bare", "-b", "main", bareDir], { cwd: root });
  await runGit(["config", "uploadpack.allowFilter", "true"], { cwd: bareDir });
  await runGit(["config", "uploadpack.allowAnySHA1InWant", "true"], { cwd: bareDir });

  await mkdir(seedDir, { recursive: true });
  await runGit(["init", "-b", "main", seedDir], { cwd: root });
  await runGit(["config", "core.autocrlf", "false"], { cwd: seedDir });

  const content = opts.contentFiles ?? {
    "users.docs.json": [
      { _id: "u1", email: "a@example.com", name: "Alice" },
      { _id: "u2", email: "b@example.com", name: "Bob" },
    ],
  };
  await writeFilesToSeed(seedDir, content);
  await runGit(["add", "."], { cwd: seedDir, env: AUTHOR_ENV });
  await runGit(["commit", "--allow-empty", "-m", "seed main"], { cwd: seedDir, env: AUTHOR_ENV });
  await runGit(["remote", "add", "origin", bareDir], { cwd: seedDir });
  await runGit(["push", "origin", "main"], { cwd: seedDir, env: AUTHOR_ENV });

  await runGit(["checkout", "--orphan", "index"], { cwd: seedDir, env: AUTHOR_ENV });
  await runGit(["rm", "-rf", "--ignore-unmatch", "."], { cwd: seedDir, env: AUTHOR_ENV });
  const indexFiles = opts.indexFiles ?? {
    "users.meta.json": { indexes: [] },
  };
  await writeFilesToSeed(seedDir, indexFiles);
  await runGit(["add", "."], { cwd: seedDir, env: AUTHOR_ENV });
  await runGit(["commit", "--allow-empty", "-m", "seed index"], { cwd: seedDir, env: AUTHOR_ENV });
  await runGit(["push", "origin", "index"], { cwd: seedDir, env: AUTHOR_ENV });

  return {
    bareDir,
    fileUrl: toFileUrl(bareDir),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function writeFilesToSeed(seedDir: string, files: Record<string, unknown | Buffer>): Promise<void> {
  for (const [name, value] of Object.entries(files)) {
    const abs = join(seedDir, name);
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      await writeFile(abs, value);
    } else {
      await writeFile(abs, JSON.stringify(value), "utf8");
    }
  }
}

export function toFileUrl(absPath: string): string {
  const norm = absPath.replace(/\\/g, "/");
  return norm.startsWith("/") ? `file://${norm}` : `file:///${norm}`;
}
