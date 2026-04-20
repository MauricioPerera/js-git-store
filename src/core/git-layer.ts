import { promises as fs } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import type { Branch } from "./branch-router.js";
import { FileLock, InProcessCommitQueue } from "./commit-queue.js";
import * as git from "./git.js";
import { GitStoreError } from "./types.js";
import type { Logger } from "../logger.js";
import type { MetricsCollector } from "../metrics.js";
import { exists } from "../adapters/git-store-internal.js";

export interface GitLayerConfig {
  repoUrl: string;
  contentRef: string;
  indexRef: string;
  indexDepth: number | undefined;
  gitTimeoutMs: number;
  lockTimeoutMs: number;
  staleLockMs: number;
  gcIntervalMs: number;
  author?: { name: string; email: string };
  commitMessage: (changedFiles: string[]) => string;
  authResolver: () => git.AuthCallOpts;
}

export class GitLayer {
  private readonly cfg: GitLayerConfig;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  readonly contentDir: string;
  readonly indexDir: string;
  private readonly cacheDir: string;
  private readonly lockPath: string;
  private readonly queue = new InProcessCommitQueue();
  private initPromise: Promise<void> | null = null;
  private gcTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(cfg: GitLayerConfig, cacheDir: string, logger: Logger, metrics: MetricsCollector) {
    this.cfg = cfg; this.logger = logger; this.metrics = metrics;
    this.cacheDir = cacheDir;
    this.contentDir = join(cacheDir, "content");
    this.indexDir = join(cacheDir, "index");
    this.lockPath = join(cacheDir, ".lock");
  }

  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit().catch((err: unknown) => { this.initPromise = null; throw err; });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const needContent = !(await exists(join(this.contentDir, ".git")));
    const needIndex = !(await exists(join(this.indexDir, ".git")));
    const base = needContent || needIndex ? this.cfg.authResolver() : { timeoutMs: this.cfg.gitTimeoutMs };
    if (needContent) {
      await git.clone(this.cfg.repoUrl, this.contentDir, this.cfg.contentRef, { ...base, filterBlobs: true, noCheckout: true });
      await this.configureRepo(this.contentDir);
    }
    if (needIndex) {
      const indexOpts = { ...base, ...(this.cfg.indexDepth ? { depth: this.cfg.indexDepth } : {}) };
      await git.clone(this.cfg.repoUrl, this.indexDir, this.cfg.indexRef, indexOpts);
      await this.configureRepo(this.indexDir);
    }
    this.startGcTimer();
  }

  private async configureRepo(dir: string): Promise<void> {
    await git.runGit(["config", "core.autocrlf", "false"], { cwd: dir });
    await git.runGit(["config", "core.safecrlf", "false"], { cwd: dir });
  }

  private startGcTimer(): void {
    if (this.cfg.gcIntervalMs <= 0 || this.gcTimer) return;
    this.gcTimer = setInterval(() => {
      this.gc().catch((err: unknown) => this.logger.warn("gc.background.error", { error: String(err) }));
    }, this.cfg.gcIntervalMs);
    this.gcTimer.unref?.();
  }

  queueSize(): number { return this.queue.size(); }

  dirFor(branch: Branch): string { return branch === "content" ? this.contentDir : this.indexDir; }

  async readIndexFile(filename: string): Promise<Buffer> {
    return fs.readFile(join(this.indexDir, filename));
  }

  async readContentBlob(filename: string): Promise<Buffer> {
    return git.showBlob(this.contentDir, "HEAD", filename, this.cfg.authResolver());
  }

  async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const waitStart = Date.now();
    return this.queue.enqueue(async () => {
      this.metrics.histogram("gitstore.queue.wait.ms").observe(Date.now() - waitStart);
      this.logger.debug("commit.queue.wait", { waitedMs: Date.now() - waitStart });
      const lock = new FileLock(this.lockPath, { staleMs: this.cfg.staleLockMs, timeoutMs: this.cfg.lockTimeoutMs });
      await lock.acquire();
      try { return await fn(); } finally { await lock.release(); }
    });
  }

  async stageFile(branch: Branch, filename: string, data: Buffer | string): Promise<void> {
    const dir = this.dirFor(branch);
    await atomicWriteFile(join(dir, filename), data);
    await git.runGit(["add", "--", filename], { cwd: dir, timeoutMs: this.cfg.gitTimeoutMs });
  }

  async stageDelete(branch: Branch, filename: string): Promise<void> {
    const dir = this.dirFor(branch);
    try {
      await git.runGit(["rm", "--cached", "--quiet", "--ignore-unmatch", "--", filename], { cwd: dir, timeoutMs: this.cfg.gitTimeoutMs });
    } catch (err) { this.logger.debug("delete.index.skip", { filename, err: String(err) }); }
    await fs.unlink(join(dir, filename)).catch(() => {});
  }

  async commitIfDirty(branch: Branch, files: string[]): Promise<string | null> {
    const dir = this.dirFor(branch);
    let dirty = false;
    try {
      await git.runGit(["diff-index", "--cached", "--quiet", "HEAD", "--"], { cwd: dir, timeoutMs: this.cfg.gitTimeoutMs });
    } catch (err) {
      if (err instanceof GitStoreError && / exited 1:/.test(err.message)) dirty = true; else throw err;
    }
    if (!dirty) return null;
    const opts: { author?: { name: string; email: string }; timeoutMs: number } = { timeoutMs: this.cfg.gitTimeoutMs };
    if (this.cfg.author) opts.author = this.cfg.author;
    const sha = await git.commitAll(dir, this.cfg.commitMessage(files), opts);
    this.logger.info("commit.created", { branch, sha, filesChanged: files.length });
    this.metrics.counter("gitstore.commit").inc(1, { branch });
    return sha;
  }

  async pushBoth(): Promise<void> {
    const opts = this.cfg.authResolver();
    await git.push(this.contentDir, "origin", this.cfg.contentRef, opts);
    await git.push(this.indexDir, "origin", this.cfg.indexRef, opts);
  }

  async refreshBoth(opts: { force?: boolean } = {}): Promise<void> {
    const auth = this.cfg.authResolver();
    await git.runGit(["fetch", "--no-tags", "origin", this.cfg.contentRef], { cwd: this.contentDir, ...auth });
    await git.runGit(["fetch", "--no-tags", "origin", this.cfg.indexRef], { cwd: this.indexDir, ...auth });
    if (!opts.force) await this.assertNoUnpushed();
    await git.runGit(["update-ref", "HEAD", `refs/remotes/origin/${this.cfg.contentRef}`], { cwd: this.contentDir });
    await git.runGit(["reset", "--hard", `origin/${this.cfg.indexRef}`], { cwd: this.indexDir });
    this.metrics.counter("gitstore.refresh").inc();
  }

  private async assertNoUnpushed(): Promise<void> {
    const check = async (dir: string, ref: string): Promise<void> => {
      const res = await git.runGit(["rev-list", "--count", `origin/${ref}..HEAD`], { cwd: dir, timeoutMs: this.cfg.gitTimeoutMs });
      const n = parseInt(res.stdout.trim(), 10);
      if (Number.isFinite(n) && n > 0) {
        throw new GitStoreError("CONCURRENT_WRITE", `${n} unpushed commit(s) on ${ref} — push first or pass { force: true }`);
      }
    };
    await check(this.contentDir, this.cfg.contentRef);
    await check(this.indexDir, this.cfg.indexRef);
  }

  async gc(): Promise<void> {
    if (this.closed) throw new GitStoreError("ADAPTER_CLOSED", "adapter is closed");
    await this.init();
    await this.withWriteLock(async () => {
      const t0 = Date.now(); const a = ["gc", "--auto", "--quiet"]; const o = { timeoutMs: this.cfg.gitTimeoutMs };
      await git.runGit(a, { cwd: this.contentDir, ...o });
      await git.runGit(a, { cwd: this.indexDir, ...o });
      const dur = Date.now() - t0;
      this.logger.info("gc.completed", { durationMs: dur });
      this.metrics.counter("gitstore.gc").inc();
      this.metrics.histogram("gitstore.gc.ms").observe(dur);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.gcTimer) { clearInterval(this.gcTimer); this.gcTimer = null; }
    try { await this.queue.drain(); } catch (err) { this.logger.warn("close.drain.error", { error: String(err) }); }
    await fs.unlink(this.lockPath).catch(() => {});
  }
}
