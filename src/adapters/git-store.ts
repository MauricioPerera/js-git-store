import { makeBranchRouter, type Branch, type BranchRouter } from "../core/branch-router.js";
import { CacheLayer } from "../core/cache-layer.js";
import * as git from "../core/git.js";
import { GitLayer } from "../core/git-layer.js";
import { GitStoreError } from "../core/types.js";
import type { Logger } from "../logger.js";
import type { MetricsCollector } from "../metrics.js";
import { type ResolvedConfig, assertSafeFilename, isMissing, resolveConfig, toBuffer } from "./git-store-internal.js";

export interface GitStoreConfig {
  repoUrl: string;
  localCacheDir: string;
  indexRef?: string;
  contentRef?: string;
  heavyFileRegex?: RegExp;
  authEnvVar?: string;
  pushOnPersist?: boolean;
  logger?: Logger;
  metrics?: MetricsCollector;
  gitTimeoutMs?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  author?: { name: string; email: string };
  commitMessage?: (changedFiles: string[]) => string;
  maxCacheBytes?: number;
  /** Reject persist() when the commit queue has this many pending ops. 0 = unlimited. Default 0. */
  maxPendingWrites?: number;
  /** Clone depth for the index branch. 0 or negative = full history. Default 1. */
  indexDepth?: number;
  /**
   * If > 0, run `git gc --auto` on both worktrees every N ms in the background.
   * Cleared on close(). Default 0 (off — caller invokes gc() manually or ignores it).
   */
  gcIntervalMs?: number;
}

export class GitStoreAdapter {
  private readonly cfg: ResolvedConfig;
  private readonly router: BranchRouter;
  private readonly cache: CacheLayer;
  private readonly gitLayer: GitLayer;
  private readonly inflight = new Map<string, Promise<void>>();
  private closed = false;

  constructor(config: GitStoreConfig) {
    this.cfg = resolveConfig(config);
    this.router = makeBranchRouter(this.cfg.heavyFileRegex);
    this.cache = new CacheLayer({ maxBytes: this.cfg.maxCacheBytes, logger: this.cfg.logger, metrics: this.cfg.metrics });
    this.gitLayer = new GitLayer({
      repoUrl: this.cfg.repoUrl,
      contentRef: this.cfg.contentRef,
      indexRef: this.cfg.indexRef,
      indexDepth: this.cfg.indexDepth,
      gitTimeoutMs: this.cfg.gitTimeoutMs,
      lockTimeoutMs: this.cfg.lockTimeoutMs,
      staleLockMs: this.cfg.staleLockMs,
      gcIntervalMs: this.cfg.gcIntervalMs,
      commitMessage: this.cfg.commitMessage,
      ...(this.cfg.author !== undefined ? { author: this.cfg.author } : {}),
      authResolver: () => this.authBase(),
    }, this.cfg.localCacheDir, this.cfg.logger, this.cfg.metrics);
  }

  readJson<T = unknown>(filename: string): T | null { assertSafeFilename(filename); return this.cache.readJson<T>(filename); }
  readBin(filename: string): ArrayBuffer | null { assertSafeFilename(filename); return this.cache.readBin(filename); }
  /** Zero-copy view — see CacheLayer.readBinShared() docstring before using. */
  readBinShared(filename: string): Uint8Array | null { assertSafeFilename(filename); return this.cache.readBinShared(filename); }
  writeJson(filename: string, data: unknown): void { assertSafeFilename(filename); this.cache.writeJson(filename, data); }
  writeBin(filename: string, buffer: ArrayBuffer | Uint8Array): void { assertSafeFilename(filename); this.cache.writeBin(filename, toBuffer(buffer)); }
  delete(filename: string): void { assertSafeFilename(filename); this.cache.delete(filename); }
  invalidate(filename: string): boolean { assertSafeFilename(filename); return this.cache.invalidate(filename); }
  cacheBytes(): number { return this.cache.bytes(); }
  cacheEntryCount(): number { return this.cache.entryCount(); }

  async preload(filenames: readonly string[]): Promise<void> {
    this.ensureOpen();
    for (const f of filenames) assertSafeFilename(f);
    await this.gitLayer.init();
    const toLoad = filenames.filter((f) => !this.cache.has(f));
    await Promise.all(toLoad.map((f) => this.loadOne(f)));
  }

  async persist(): Promise<void> {
    this.ensureOpen();
    await this.gitLayer.init();
    if (this.cfg.maxPendingWrites > 0 && this.gitLayer.queueSize() >= this.cfg.maxPendingWrites) {
      this.cfg.metrics.counter("gitstore.persist.backpressure").inc();
      throw new GitStoreError("BACKPRESSURE", `commit queue has ${this.gitLayer.queueSize()} pending ops (cap ${this.cfg.maxPendingWrites})`);
    }
    const dirty = this.cache.dirtyEntries();
    if (dirty.length === 0) return;
    const persistStarted = Date.now();
    await this.gitLayer.withWriteLock(async () => {
      const writesByBranch = new Map<Branch, string[]>();
      for (const [f, e] of dirty) {
        const b = this.router.branchOf(f);
        if (e.deleted) {
          await this.gitLayer.removeStaged(b, f);
        } else if (e.variant === "json") {
          await this.gitLayer.writeStaged(b, f, e.jsonSerialized ?? JSON.stringify(e.json));
          const list = writesByBranch.get(b) ?? []; list.push(f); writesByBranch.set(b, list);
        } else if (e.bin) {
          await this.gitLayer.writeStaged(b, f, e.bin);
          const list = writesByBranch.get(b) ?? []; list.push(f); writesByBranch.set(b, list);
        }
      }
      for (const [branch, files] of writesByBranch) await this.gitLayer.addBatch(branch, files);
      const allFilesByBranch = new Map<Branch, string[]>();
      for (const [f, _e] of dirty) {
        const b = this.router.branchOf(f);
        const list = allFilesByBranch.get(b) ?? []; list.push(f); allFilesByBranch.set(b, list);
      }
      for (const [branch, files] of allFilesByBranch) await this.gitLayer.commitIfDirty(branch, files);
      this.cache.commitDirty(dirty);
      if (this.cfg.pushOnPersist) await this.gitLayer.pushBoth();
    });
    this.cfg.metrics.counter("gitstore.persist").inc(1);
    this.cfg.metrics.histogram("gitstore.persist.ms").observe(Date.now() - persistStarted);
  }

  async push(): Promise<void> {
    this.ensureOpen();
    await this.gitLayer.init();
    await this.gitLayer.withWriteLock(() => this.gitLayer.pushBoth());
  }

  /**
   * Fetch origin + drop clean cache. Dirty cache entries are preserved.
   * Throws `CONCURRENT_WRITE` if local un-pushed commits exist on either branch
   * (calling `refresh()` would discard them). Pass `{ force: true }` to override.
   * Throws `INVALID_CONFIG` if either ref is pinned to a SHA.
   */
  async refresh(opts: { force?: boolean } = {}): Promise<void> {
    this.ensureOpen();
    const sha = /^[0-9a-f]{7,40}$/i;
    if (sha.test(this.cfg.contentRef) || sha.test(this.cfg.indexRef)) throw new GitStoreError("INVALID_CONFIG", "refresh() requires branch/tag refs, not SHAs");
    await this.gitLayer.init();
    await this.gitLayer.withWriteLock(async () => {
      await this.gitLayer.refreshBoth(opts);
      const dropped = this.cache.dropClean();
      this.cfg.logger.info("refresh", { droppedEntries: dropped, force: !!opts.force });
    });
  }

  /** `git gc --auto` on both worktrees. Serialized via queue + flock. */
  async gc(): Promise<void> {
    this.ensureOpen();
    await this.gitLayer.gc();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.gitLayer.close();
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }

  private ensureOpen(): void {
    if (this.closed) throw new GitStoreError("ADAPTER_CLOSED", "adapter is closed");
  }

  private loadOne(filename: string): Promise<void> {
    if (this.cache.has(filename)) return Promise.resolve();
    const running = this.inflight.get(filename);
    if (running) return running;
    const p = this.doLoadOne(filename).finally(() => this.inflight.delete(filename));
    this.inflight.set(filename, p);
    return p;
  }

  private async doLoadOne(filename: string): Promise<void> {
    const branch = this.router.branchOf(filename);
    const isJson = filename.endsWith(".json");
    const started = Date.now();
    try {
      const buf = branch === "index"
        ? await this.gitLayer.readIndexFile(filename)
        : await this.gitLayer.readContentBlob(filename);
      this.cache.loaded(filename, buf, isJson);
      this.cfg.logger.debug("blob.fetch.hit", { filename, branch });
      this.cfg.metrics.counter("gitstore.blob.fetch").inc(1, { branch, result: "ok" });
      this.cfg.metrics.histogram("gitstore.blob.fetch.ms").observe(Date.now() - started, { branch });
    } catch (err) {
      if (isMissing(err)) {
        this.cfg.logger.debug("blob.fetch.miss", { filename, branch });
        this.cfg.metrics.counter("gitstore.blob.fetch").inc(1, { branch, result: "miss" });
        return;
      }
      this.cfg.metrics.counter("gitstore.blob.fetch").inc(1, { branch, result: "error" });
      throw err;
    }
  }

  private authBase(): git.AuthCallOpts {
    const authEnv = this.resolveAuthEnv();
    const base: git.AuthCallOpts = { timeoutMs: this.cfg.gitTimeoutMs };
    if (!authEnv) return base;
    const token = Object.values(authEnv)[0] ?? "";
    const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
    base.authEnv = authEnv;
    base.redactor = git.makeTokenRedactor(token, b64);
    base.configs = { "http.extraHeader": `Authorization: Basic ${b64}` };
    return base;
  }

  private resolveAuthEnv(): Record<string, string> | undefined {
    if (!this.cfg.authEnvVar) return undefined;
    const token = process.env[this.cfg.authEnvVar];
    if (!token || token.length === 0) throw new GitStoreError("AUTH_MISSING", `env var "${this.cfg.authEnvVar}" is not set`);
    return { [this.cfg.authEnvVar]: token };
  }
}
