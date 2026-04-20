import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { GitStoreError } from "./types.js";

export interface CommitQueue {
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
  size(): number;
}

export class InProcessCommitQueue implements CommitQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;

  size(): number {
    return this.pending;
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const next = this.chain.then(
      async () => {
        try {
          return await fn();
        } finally {
          this.pending -= 1;
        }
      },
      async () => {
        try {
          return await fn();
        } finally {
          this.pending -= 1;
        }
      },
    );
    this.chain = next.catch(() => {});
    return next as Promise<T>;
  }

  async drain(): Promise<void> {
    const snap = this.chain;
    await snap.catch(() => {});
    while (this.pending > 0) {
      await this.chain.catch(() => {});
    }
  }
}

export interface FileLockOptions {
  staleMs: number;
  timeoutMs: number;
  pollMs?: number;
}

export class FileLock {
  private readonly path: string;
  private readonly opts: FileLockOptions;
  private held = false;

  constructor(path: string, opts: FileLockOptions) {
    this.path = path;
    this.opts = opts;
  }

  async acquire(): Promise<void> {
    if (this.held) throw new GitStoreError("LOCK_TIMEOUT", "lock already held by this instance");
    const deadline = Date.now() + this.opts.timeoutMs;
    const pollMs = this.opts.pollMs ?? 50;
    await fs.mkdir(dirname(this.path), { recursive: true });
    while (true) {
      try {
        const handle = await fs.open(this.path, "wx");
        await handle.writeFile(String(process.pid));
        await handle.close();
        this.held = true;
        return;
      } catch (err) {
        if (!isExistsErr(err)) throw err;
        if (await this.tryStealStale()) continue;
        if (Date.now() >= deadline) {
          throw new GitStoreError(
            "LOCK_TIMEOUT",
            `failed to acquire lock at ${this.path} within ${this.opts.timeoutMs}ms`,
          );
        }
        await sleep(pollMs);
      }
    }
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    await fs.unlink(this.path).catch(() => {});
  }

  private async tryStealStale(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.path);
      const age = Date.now() - stat.mtimeMs;
      if (age > this.opts.staleMs) {
        await fs.unlink(this.path).catch(() => {});
        return true;
      }
    } catch {
      return true;
    }
    return false;
  }
}

function isExistsErr(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "EEXIST";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
