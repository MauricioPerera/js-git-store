import { describe, expect, it } from "vitest";
import { buildGitEnv, makeTokenRedactor, runGit } from "../../src/core/git.js";
import { GitStoreError } from "../../src/core/types.js";

describe("buildGitEnv", () => {
  it("injects GIT_TERMINAL_PROMPT=0", () => {
    const env = buildGitEnv({});
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("merges authEnv without mutating process.env", () => {
    const before = { ...process.env };
    const env = buildGitEnv(process.env, { SECRET_TOKEN: "abc123" });
    expect(env["SECRET_TOKEN"]).toBe("abc123");
    expect(process.env["SECRET_TOKEN"]).toBe(before["SECRET_TOKEN"]);
  });

  it("extra env overrides authEnv overrides base", () => {
    const env = buildGitEnv(
      { A: "1", B: "1" },
      { A: "2" },
      { A: "3" },
    );
    expect(env["A"]).toBe("3");
    expect(env["B"]).toBe("1");
  });
});

describe("makeTokenRedactor", () => {
  it("redacts the literal token from text", () => {
    const redact = makeTokenRedactor("ghp_verysecret");
    expect(redact("error using ghp_verysecret for auth")).toBe("error using *** for auth");
  });

  it("handles empty tokens as identity", () => {
    const redact = makeTokenRedactor("");
    expect(redact("hello")).toBe("hello");
  });

  it("escapes regex metacharacters in the token", () => {
    const redact = makeTokenRedactor("a.b+c");
    expect(redact("a.b+c x a.b+c")).toBe("*** x ***");
  });

  it("redacts multiple tokens in one pass", () => {
    const redact = makeTokenRedactor("ghp_secret", "eCtzZWNyZXQ=");
    expect(redact("raw ghp_secret and b64 eCtzZWNyZXQ= here")).toBe("raw *** and b64 *** here");
  });

  it("ignores empty args", () => {
    const redact = makeTokenRedactor("", "real");
    expect(redact("hello real world")).toBe("hello *** world");
  });
});

describe("runGit error shape", () => {
  it("throws GitStoreError(GIT_COMMAND_FAILED) on non-zero exit", async () => {
    await expect(
      runGit(["rev-parse", "--verify", "refs/heads/definitely-not-a-ref"], {
        cwd: process.cwd(),
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ name: "GitStoreError", code: "GIT_COMMAND_FAILED" });
  });

  it("applies redactor to stderr + argv in the thrown error", async () => {
    const token = "ghp_redactme-badref";
    const err = await runGit(["rev-parse", "--verify", token], {
      cwd: process.cwd(),
      redactor: makeTokenRedactor(token),
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitStoreError);
    expect((err as Error).message).not.toContain(token);
    expect((err as Error).message).toContain("***");
  });
});
