/**
 * End-to-end integration against a REAL private GitHub repository.
 *
 * Creates an ephemeral private repo under the current `gh` user, exercises
 * the HTTPS auth path (clone + push with `Authorization: Bearer <token>`),
 * verifies the token is redacted from error surfaces, and deletes the repo
 * in a finally block.
 *
 * Run: npm run e2e:github
 *
 * Requires:
 *   - `gh` CLI authenticated with `repo` scope
 *   - Network access to github.com
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/core/git.js";
import { GitStoreAdapter, GitStoreError } from "../../src/index.js";

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

async function main(): Promise<void> {
  const login = sh("gh", ["api", "user", "--jq", ".login"]);
  const token = sh("gh", ["auth", "token"]);
  if (!token) throw new Error("gh auth token returned empty");

  const repoName = `js-git-store-e2e-${Date.now()}`;
  const fullName = `${login}/${repoName}`;
  const httpsUrl = `https://github.com/${fullName}.git`;

  console.log(`creating private repo ${fullName} ...`);
  sh("gh", ["repo", "create", fullName, "--private", "--description", "ephemeral js-git-store E2E test"]);

  let deleted = false;
  const cleanup = (): void => {
    if (deleted) return;
    try {
      console.log(`deleting repo ${fullName} ...`);
      sh("gh", ["repo", "delete", fullName, "--yes"]);
      deleted = true;
    } catch {
      console.warn("");
      console.warn("================================================================");
      console.warn(`  Could not auto-delete ${fullName}.`);
      console.warn("  Your gh token likely lacks the 'delete_repo' scope.");
      console.warn("  Delete manually:   gh repo delete " + fullName + " --yes");
      console.warn("  Or grant scope:    gh auth refresh -h github.com -s delete_repo");
      console.warn("================================================================");
    }
  };

  const work = await mkdtemp(join(tmpdir(), "gls-e2e-"));
  process.on("uncaughtException", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  try {
    const seed = join(work, "seed");
    await writeFile(join(work, ".gitkeep"), "", "utf8");
    const authUrl = `https://x-access-token:${token}@github.com/${fullName}.git`;
    const authorEnv = {
      GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@local",
      GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@local",
    };

    await runGit(["init", "-b", "main", seed], { cwd: work });
    await runGit(["config", "core.autocrlf", "false"], { cwd: seed });
    await writeFile(join(seed, "users.docs.json"), JSON.stringify([
      { _id: "u1", email: "a@example.com", name: "Alice" },
    ]), "utf8");
    await runGit(["add", "."], { cwd: seed, env: authorEnv });
    await runGit(["commit", "-m", "seed main"], { cwd: seed, env: authorEnv });
    await runGit(["remote", "add", "origin", authUrl], { cwd: seed });
    await runGit(["push", "origin", "main"], { cwd: seed, env: authorEnv });

    await runGit(["checkout", "--orphan", "index"], { cwd: seed, env: authorEnv });
    await runGit(["rm", "-rf", "--ignore-unmatch", "."], { cwd: seed, env: authorEnv });
    await writeFile(join(seed, "users.meta.json"), JSON.stringify({ indexes: [] }), "utf8");
    await runGit(["add", "."], { cwd: seed, env: authorEnv });
    await runGit(["commit", "-m", "seed index"], { cwd: seed, env: authorEnv });
    await runGit(["push", "origin", "index"], { cwd: seed, env: authorEnv });
    console.log(`seeded ${fullName} with main + index`);

    process.env["JS_GIT_STORE_GH_TOKEN"] = token;
    const cacheDir = join(work, "cache");
    const adapter = new GitStoreAdapter({
      repoUrl: httpsUrl,
      localCacheDir: cacheDir,
      authEnvVar: "JS_GIT_STORE_GH_TOKEN",
    });

    console.log("preloading via HTTPS with bearer token header ...");
    await adapter.preload(["users.docs.json", "users.meta.json"]);
    const users = adapter.readJson("users.docs.json");
    if (!Array.isArray(users) || users.length !== 1) throw new Error(`expected 1 user, got ${JSON.stringify(users)}`);
    console.log(`  read ${users.length} doc(s)`);

    console.log("writing + persisting + pushing via HTTPS ...");
    adapter.writeJson("users.docs.json", [
      { _id: "u1", email: "a@example.com", name: "Alice" },
      { _id: "u2", email: "b@example.com", name: "Bob" },
    ]);
    await adapter.persist();
    await adapter.push();
    console.log("  pushed");

    console.log("verifying redaction: provoking an error with the token in the path ...");
    const bogusAdapter = new GitStoreAdapter({
      repoUrl: httpsUrl,
      localCacheDir: join(work, "cache-bogus"),
      authEnvVar: "JS_GIT_STORE_GH_TOKEN",
      indexRef: "nonexistent-branch",
    });
    const err = await bogusAdapter.preload([]).catch((e: unknown) => e);
    if (!(err instanceof GitStoreError)) throw new Error("expected GitStoreError");
    const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
    if (err.message.includes(token)) throw new Error(`REDACTION FAIL: raw token leaked: ${err.message}`);
    if (err.message.includes(b64)) throw new Error(`REDACTION FAIL: b64 token leaked: ${err.message}`);
    console.log(`  error code=${err.code}, no token in message (${err.message.length} chars)`);
    await bogusAdapter.close();

    console.log("verifying second reader sees the push ...");
    const readerDir = join(work, "reader");
    const reader = new GitStoreAdapter({
      repoUrl: httpsUrl,
      localCacheDir: readerDir,
      authEnvVar: "JS_GIT_STORE_GH_TOKEN",
    });
    await reader.preload(["users.docs.json"]);
    const fresh = reader.readJson("users.docs.json");
    if (!Array.isArray(fresh) || fresh.length !== 2) throw new Error(`second reader saw ${JSON.stringify(fresh)}`);
    console.log(`  second reader sees ${fresh.length} docs`);
    await reader.close();
    await adapter.close();

    console.log("E2E PASS");
  } finally {
    await rm(work, { recursive: true, force: true });
    cleanup();
  }
}

main().catch((err: unknown) => {
  console.error("E2E FAIL");
  console.error(err);
  process.exit(1);
});
