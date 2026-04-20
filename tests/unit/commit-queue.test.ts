import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLock, InProcessCommitQueue } from "../../src/core/commit-queue.js";
import { GitStoreError } from "../../src/core/types.js";

describe("InProcessCommitQueue", () => {
  it("runs tasks FIFO even when enqueued before awaiting", async () => {
    const q = new InProcessCommitQueue();
    const order: number[] = [];
    const p1 = q.enqueue(async () => {
      await delay(30);
      order.push(1);
    });
    const p2 = q.enqueue(async () => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("isolates task errors so later tasks still run", async () => {
    const q = new InProcessCommitQueue();
    const results: string[] = [];
    const p1 = q.enqueue(async () => {
      throw new Error("nope");
    });
    const p2 = q.enqueue(async () => {
      results.push("ok");
    });
    await expect(p1).rejects.toThrow("nope");
    await p2;
    expect(results).toEqual(["ok"]);
  });

  it("drain() waits for pending tasks", async () => {
    const q = new InProcessCommitQueue();
    let done = false;
    const p = q.enqueue(async () => {
      await delay(40);
      done = true;
    });
    await q.drain();
    expect(done).toBe(true);
    await p;
  });

  it("size() reflects pending + running", async () => {
    const q = new InProcessCommitQueue();
    q.enqueue(() => delay(20));
    q.enqueue(() => delay(20));
    expect(q.size()).toBe(2);
    await q.drain();
    expect(q.size()).toBe(0);
  });
});

describe("FileLock", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gls-lock-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("acquires and releases", async () => {
    const l = new FileLock(join(dir, ".lock"), { staleMs: 60_000, timeoutMs: 1_000 });
    await l.acquire();
    await l.release();
    await l.acquire();
    await l.release();
  });

  it("times out if another holder does not release", async () => {
    const path = join(dir, ".lock");
    const a = new FileLock(path, { staleMs: 60_000, timeoutMs: 1_000 });
    const b = new FileLock(path, { staleMs: 60_000, timeoutMs: 200, pollMs: 20 });
    await a.acquire();
    await expect(b.acquire()).rejects.toBeInstanceOf(GitStoreError);
    await a.release();
  });

  it("steals stale lock", async () => {
    const path = join(dir, ".lock");
    const a = new FileLock(path, { staleMs: 50, timeoutMs: 1_000 });
    const b = new FileLock(path, { staleMs: 50, timeoutMs: 2_000, pollMs: 20 });
    await a.acquire();
    await delay(120);
    await b.acquire();
    await b.release();
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
