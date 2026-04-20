/**
 * Quick E2E against an already-seeded private GitHub repo.
 * Use when gh token lacks delete_repo scope — reuses a named repo and does NOT delete.
 *
 * Run: JS_GIT_STORE_GH_REPO=owner/repo npm run e2e:github-quick
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitStoreAdapter, GitStoreError } from "../../src/index.js";

function sh(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function main(): Promise<void> {
  const repo = process.env["JS_GIT_STORE_GH_REPO"];
  if (!repo) throw new Error("set JS_GIT_STORE_GH_REPO=owner/repo");
  const token = sh("gh", ["auth", "token"]);
  const httpsUrl = `https://github.com/${repo}.git`;
  process.env["JS_GIT_STORE_GH_TOKEN"] = token;

  const work = await mkdtemp(join(tmpdir(), "gls-q-"));
  try {
    const adapter = new GitStoreAdapter({
      repoUrl: httpsUrl,
      localCacheDir: join(work, "cache"),
      authEnvVar: "JS_GIT_STORE_GH_TOKEN",
    });
    console.log(`clone+preload from ${repo} ...`);
    await adapter.preload(["users.docs.json", "users.meta.json"]);
    const users = adapter.readJson("users.docs.json");
    if (!Array.isArray(users)) throw new Error(`unexpected: ${JSON.stringify(users)}`);
    console.log(`  read ${users.length} docs`);

    adapter.writeJson("users.docs.json", [
      ...(users as Record<string, unknown>[]),
      { _id: `u-${Date.now()}`, name: "pushed-via-e2e", ts: new Date().toISOString() },
    ]);
    console.log("persist + push via HTTPS bearer-basic header ...");
    await adapter.persist();
    await adapter.push();
    console.log("  pushed");

    console.log("verify redaction: error path must not leak the token ...");
    const bogus = new GitStoreAdapter({
      repoUrl: httpsUrl,
      localCacheDir: join(work, "cache-bogus"),
      authEnvVar: "JS_GIT_STORE_GH_TOKEN",
      indexRef: "nonexistent-ref",
    });
    const err = await bogus.preload([]).catch((e: unknown) => e);
    if (!(err instanceof GitStoreError)) throw new Error("expected GitStoreError");
    if (err.message.includes(token)) throw new Error("REDACTION FAIL: raw token leaked");
    const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
    if (err.message.includes(b64)) throw new Error("REDACTION FAIL: base64 token leaked");
    console.log(`  error.code=${err.code}, no token in message (${err.message.length} chars)`);
    await bogus.close();

    console.log("second reader sees the push ...");
    const reader = new GitStoreAdapter({
      repoUrl: httpsUrl,
      localCacheDir: join(work, "reader"),
      authEnvVar: "JS_GIT_STORE_GH_TOKEN",
    });
    await reader.preload(["users.docs.json"]);
    const fresh = reader.readJson("users.docs.json") as Record<string, unknown>[];
    console.log(`  second reader sees ${fresh.length} docs; last._id=${JSON.stringify(fresh[fresh.length - 1]?.["_id"])}`);
    await reader.close();
    await adapter.close();
    console.log("E2E quick PASS");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error("E2E quick FAIL");
  console.error(err);
  process.exit(1);
});
