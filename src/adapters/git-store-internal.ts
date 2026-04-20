import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_HEAVY_REGEX } from "../core/branch-router.js";
import { GitStoreError } from "../core/types.js";
import { noopLogger, type Logger } from "../logger.js";
import { noopMetrics, type MetricsCollector } from "../metrics.js";
import type { GitStoreConfig } from "./git-store.js";

export const DEFAULTS = {
  indexRef: "index",
  contentRef: "main",
  pushOnPersist: false,
  gitTimeoutMs: 30_000,
  lockTimeoutMs: 30_000,
  staleLockMs: 60_000,
  maxCacheBytes: 500 * 1024 * 1024,
  maxPendingWrites: 0,
};

export type ResolvedConfig = Required<Pick<GitStoreConfig,
  "repoUrl" | "localCacheDir" | "indexRef" | "contentRef" | "pushOnPersist" |
  "gitTimeoutMs" | "lockTimeoutMs" | "staleLockMs" | "maxCacheBytes" | "maxPendingWrites"
>> & {
  heavyFileRegex: RegExp;
  authEnvVar?: string;
  author?: { name: string; email: string };
  commitMessage: (changedFiles: string[]) => string;
  logger: Logger;
  metrics: MetricsCollector;
  indexDepth: number | undefined;
  gcIntervalMs: number;
};

function mustPositive(name: string, v: number | undefined): void {
  if (v !== undefined && (!Number.isFinite(v) || v <= 0)) {
    throw new GitStoreError("INVALID_CONFIG", `${name} must be a positive number (got ${String(v)})`);
  }
}

function mustNonNegative(name: string, v: number | undefined): void {
  if (v !== undefined && (!Number.isFinite(v) || v < 0)) {
    throw new GitStoreError("INVALID_CONFIG", `${name} must be >= 0 (got ${String(v)})`);
  }
}

export function resolveConfig(c: GitStoreConfig): ResolvedConfig {
  if (!c.repoUrl) throw new GitStoreError("INVALID_CONFIG", "repoUrl is required");
  if (!c.localCacheDir) throw new GitStoreError("INVALID_CONFIG", "localCacheDir is required");
  mustPositive("gitTimeoutMs", c.gitTimeoutMs);
  mustPositive("lockTimeoutMs", c.lockTimeoutMs);
  mustPositive("staleLockMs", c.staleLockMs);
  mustPositive("maxCacheBytes", c.maxCacheBytes);
  mustNonNegative("maxPendingWrites", c.maxPendingWrites);
  mustNonNegative("gcIntervalMs", c.gcIntervalMs);
  if (c.author !== undefined && (!c.author.name || !c.author.email)) {
    throw new GitStoreError("INVALID_CONFIG", "author.name and author.email must be non-empty strings");
  }
  const r: ResolvedConfig = {
    repoUrl: c.repoUrl,
    localCacheDir: resolve(c.localCacheDir),
    indexRef: c.indexRef ?? DEFAULTS.indexRef,
    contentRef: c.contentRef ?? DEFAULTS.contentRef,
    heavyFileRegex: c.heavyFileRegex ?? DEFAULT_HEAVY_REGEX,
    pushOnPersist: c.pushOnPersist ?? DEFAULTS.pushOnPersist,
    gitTimeoutMs: c.gitTimeoutMs ?? DEFAULTS.gitTimeoutMs,
    lockTimeoutMs: c.lockTimeoutMs ?? DEFAULTS.lockTimeoutMs,
    staleLockMs: c.staleLockMs ?? DEFAULTS.staleLockMs,
    maxCacheBytes: c.maxCacheBytes ?? DEFAULTS.maxCacheBytes,
    maxPendingWrites: c.maxPendingWrites ?? DEFAULTS.maxPendingWrites,
    logger: c.logger ?? noopLogger,
    metrics: c.metrics ?? noopMetrics,
    commitMessage: c.commitMessage ?? defaultCommitMessage,
    indexDepth: c.indexDepth === undefined ? 1 : (c.indexDepth > 0 ? c.indexDepth : undefined),
    gcIntervalMs: c.gcIntervalMs ?? 0,
  };
  if (c.authEnvVar !== undefined) r.authEnvVar = c.authEnvVar;
  if (c.author !== undefined) r.author = c.author;
  return r;
}

export function defaultCommitMessage(changed: string[]): string {
  return `js-git-store: persist ${changed.length} file(s)`;
}

export function toBuffer(src: ArrayBuffer | Uint8Array): Buffer {
  if (src instanceof Uint8Array) return Buffer.from(src.buffer, src.byteOffset, src.byteLength);
  return Buffer.from(new Uint8Array(src));
}

export async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

export function isMissing(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: string }).code;
  if (code === "ENOENT") return true;
  const msg = (err as { message?: string }).message ?? "";
  return (
    /exists on disk, but not in/i.test(msg) ||
    /does not exist in '[^']*'/i.test(msg) ||
    /path '[^']*' does not exist in/i.test(msg) ||
    /fatal: invalid object name/i.test(msg) ||
    /fatal: Not a valid object name/i.test(msg)
  );
}
