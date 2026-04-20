import { spawn } from "node:child_process";
import { GitStoreError } from "./types.js";

export interface AuthCallOpts {
  timeoutMs?: number;
  configs?: Record<string, string>;
  authEnv?: Record<string, string>;
  redactor?: (t: string) => string;
}

export interface RunGitOptions extends AuthCallOpts {
  cwd: string;
  input?: string;
  env?: Record<string, string>;
}

export interface RunGitResult { stdout: string; stderr: string; exitCode: number; durationMs: number }

const DEFAULT_TIMEOUT_MS = 30_000;

export function buildGitEnv(base: NodeJS.ProcessEnv, authEnv?: Record<string, string>, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  env["GIT_TERMINAL_PROMPT"] = "0";
  if (authEnv) for (const [k, v] of Object.entries(authEnv)) env[k] = v;
  if (extra) for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

interface RawResult { stdout: Buffer; stderr: string; exitCode: number; durationMs: number; timedOut: boolean }

function withConfigs(args: readonly string[], configs?: Record<string, string>): string[] {
  if (!configs) return [...args];
  const pre: string[] = [];
  for (const [k, v] of Object.entries(configs)) pre.push("-c", `${k}=${v}`);
  return [...pre, ...args];
}

function spawnGit(args: readonly string[], opts: RunGitOptions): Promise<RawResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = buildGitEnv(process.env, opts.authEnv, opts.env);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  const finalArgs = withConfigs(args, opts.configs);
  return new Promise<RawResult>((resolve, reject) => {
    const child = spawn("git", finalArgs, {
      cwd: opts.cwd,
      env,
      signal: ac.signal,
      shell: false,
      windowsHide: true,
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => outChunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
    child.on("error", (err) => {
      clearTimeout(timer);
      if (ac.signal.aborted) {
        reject(new GitStoreError("GIT_COMMAND_FAILED", `git ${args[0] ?? "?"} timed out after ${timeoutMs}ms`, err));
        return;
      }
      reject(new GitStoreError("GIT_COMMAND_FAILED", String(err), err));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stderrRaw = Buffer.concat(errChunks).toString("utf8");
      const stderr = opts.redactor ? opts.redactor(stderrRaw) : stderrRaw;
      resolve({
        stdout: Buffer.concat(outChunks),
        stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - started,
        timedOut: ac.signal.aborted,
      });
    });
  });
}

function raiseIfFailed(args: readonly string[], r: RawResult, timeoutMs: number, redactor?: (t: string) => string): void {
  if (r.timedOut) throw new GitStoreError("GIT_COMMAND_FAILED", `git ${args[0] ?? "?"} timed out after ${timeoutMs}ms`);
  if (r.exitCode !== 0) {
    const raw = `git ${args.slice(0, 3).join(" ")} exited ${r.exitCode}: ${r.stderr.slice(0, 500).trim()}`;
    throw new GitStoreError("GIT_COMMAND_FAILED", redactor ? redactor(raw) : raw);
  }
}

export async function runGit(args: readonly string[], opts: RunGitOptions): Promise<RunGitResult> {
  const r = await spawnGit(args, opts);
  raiseIfFailed(args, r, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.redactor);
  return { stdout: r.stdout.toString("utf8"), stderr: r.stderr, exitCode: r.exitCode, durationMs: r.durationMs };
}

export async function runGitBuffer(args: readonly string[], opts: RunGitOptions): Promise<Buffer> {
  const r = await spawnGit(args, opts);
  raiseIfFailed(args, r, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.redactor);
  return r.stdout;
}

export interface CloneOptions extends AuthCallOpts {
  depth?: number;
  singleBranch?: boolean;
  filterBlobs?: boolean;
  noCheckout?: boolean;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export async function clone(remote: string, dir: string, ref: string, opts: CloneOptions = {}): Promise<void> {
  const isSha = SHA_RE.test(ref);
  const args: string[] = ["clone"];
  if (!isSha) args.push("--branch", ref);
  if (opts.singleBranch !== false && !isSha) args.push("--single-branch");
  if (opts.depth !== undefined && !isSha) args.push(`--depth=${opts.depth}`);
  if (opts.filterBlobs) args.push("--filter=blob:none");
  if (opts.noCheckout || isSha) args.push("--no-checkout");
  args.push("--no-tags", remote, dir);
  try { await runGit(args, mergeAuthOpts(process.cwd(), opts)); } catch (err) {
    if (err instanceof GitStoreError && /remote branch .* not found|couldn't find remote ref/i.test(err.message)) {
      throw new GitStoreError("BRANCH_NOT_FOUND", `ref "${ref}" not found at ${remote}`, err);
    }
    throw err;
  }
  if (!isSha) return;
  const fetchArgs = ["fetch", "origin", ref];
  if (opts.depth !== undefined) fetchArgs.push(`--depth=${opts.depth}`);
  if (opts.filterBlobs) fetchArgs.push("--filter=blob:none");
  const shaOpts = mergeAuthOpts(dir, opts);
  await runGit(fetchArgs, shaOpts);
  await runGit(["update-ref", "HEAD", ref], shaOpts);
  if (!opts.noCheckout) await runGit(["checkout", "--", "."], shaOpts);
}

function mergeAuthOpts(cwd: string, e: AuthCallOpts): RunGitOptions {
  const o: RunGitOptions = { cwd };
  if (e.timeoutMs !== undefined) o.timeoutMs = e.timeoutMs;
  if (e.configs) o.configs = e.configs;
  if (e.authEnv) o.authEnv = e.authEnv;
  if (e.redactor) o.redactor = e.redactor;
  return o;
}

export async function showBlob(cwd: string, ref: string, path: string, extra: AuthCallOpts = {}): Promise<Buffer> {
  try { return await runGitBuffer(["show", `${ref}:${path}`], mergeAuthOpts(cwd, extra)); } catch (err) {
    if (err instanceof GitStoreError && /timed out/.test(err.message)) {
      throw new GitStoreError("BLOB_FETCH_TIMEOUT", err.message, err);
    }
    throw err;
  }
}

export async function commitAll(
  cwd: string, message: string,
  opts: { author?: { name: string; email: string }; timeoutMs?: number; allowEmpty?: boolean } = {},
): Promise<string> {
  const a = opts.author ?? { name: "js-git-store", email: "js-git-store@local" };
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email,
    GIT_COMMITTER_NAME: a.name, GIT_COMMITTER_EMAIL: a.email,
  };
  const args = ["commit", "-m", message];
  if (opts.allowEmpty) args.push("--allow-empty");
  const cOpts: RunGitOptions = { cwd, env };
  if (opts.timeoutMs !== undefined) cOpts.timeoutMs = opts.timeoutMs;
  await runGit(args, cOpts);
  return (await runGit(["rev-parse", "HEAD"], { cwd })).stdout.trim();
}

export async function push(cwd: string, remote: string, ref: string, opts: AuthCallOpts = {}): Promise<void> {
  try { await runGit(["push", remote, `HEAD:${ref}`], mergeAuthOpts(cwd, opts)); } catch (err) {
    if (err instanceof GitStoreError && /non-fast-forward|rejected/i.test(err.message)) {
      throw new GitStoreError("CONCURRENT_WRITE", err.message, err);
    }
    throw err;
  }
}

export function makeTokenRedactor(...tokens: string[]): (text: string) => string {
  const nonEmpty = tokens.filter((t) => t && t.length > 0);
  if (nonEmpty.length === 0) return (t) => t;
  const parts = nonEmpty.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(parts.join("|"), "g");
  return (t: string) => t.replace(re, "***");
}
