import type { Logger } from "../logger.js";
import type { MetricsCollector } from "../metrics.js";

export interface CacheEntry {
  variant: "json" | "bin";
  json?: unknown;
  /** Cached JSON serialization — populated on writeJson to avoid a second stringify on persist. */
  jsonSerialized?: string;
  bin?: Buffer;
  dirty: boolean;
  deleted: boolean;
  sizeBytes: number;
}

export interface CacheLayerOptions {
  maxBytes: number;
  logger: Logger;
  metrics: MetricsCollector;
}

/**
 * In-memory Map-backed cache with LRU eviction of clean entries and O(1)
 * byte accounting via a running total. Dirty entries are never evicted
 * (they'd lose writes). Tombstones (deleted: true) stay until persist().
 */
export class CacheLayer {
  private readonly map = new Map<string, CacheEntry>();
  private readonly opts: CacheLayerOptions;
  private totalBytes = 0;

  constructor(opts: CacheLayerOptions) { this.opts = opts; }

  readJson<T = unknown>(filename: string): T | null {
    const e = this.map.get(filename);
    if (!e || e.deleted || e.variant !== "json") return null;
    this.touch(filename, e);
    return e.json as T;
  }

  readBin(filename: string): ArrayBuffer | null {
    const e = this.map.get(filename);
    if (!e || e.deleted || e.variant !== "bin" || !e.bin) return null;
    this.touch(filename, e);
    const b = e.bin;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }

  /**
   * Zero-copy view over the cached binary payload. The returned Uint8Array
   * shares memory with the cache; callers MUST NOT mutate it and MUST NOT
   * retain the reference past the next persist() / invalidate() / refresh().
   */
  readBinShared(filename: string): Uint8Array | null {
    const e = this.map.get(filename);
    if (!e || e.deleted || e.variant !== "bin" || !e.bin) return null;
    this.touch(filename, e);
    return new Uint8Array(e.bin.buffer, e.bin.byteOffset, e.bin.byteLength);
  }

  writeJson(filename: string, data: unknown): void {
    const serialized = JSON.stringify(data);
    const size = Buffer.byteLength(serialized, "utf8");
    this.set(filename, { variant: "json", json: data, jsonSerialized: serialized, dirty: true, deleted: false, sizeBytes: size });
  }

  writeBin(filename: string, buf: Buffer): void {
    this.set(filename, { variant: "bin", bin: buf, dirty: true, deleted: false, sizeBytes: buf.byteLength });
  }

  delete(filename: string): void {
    const e = this.map.get(filename);
    if (e) { e.deleted = true; e.dirty = true; return; }
    this.set(filename, { variant: "json", dirty: true, deleted: true, sizeBytes: 0 });
  }

  invalidate(filename: string): boolean {
    const e = this.map.get(filename);
    if (!e || e.dirty) return false;
    this.unset(filename);
    return true;
  }

  /** Populate a cache slot from a newly-fetched blob (loaded, not dirty). */
  loaded(filename: string, buf: Buffer, isJson: boolean): void {
    if (isJson) {
      const json = JSON.parse(buf.toString("utf8"));
      this.set(filename, { variant: "json", json, dirty: false, deleted: false, sizeBytes: buf.byteLength });
    } else {
      this.set(filename, { variant: "bin", bin: buf, dirty: false, deleted: false, sizeBytes: buf.byteLength });
    }
    this.evictIfOverBudget();
  }

  has(filename: string): boolean { return this.map.has(filename); }
  bytes(): number { return this.totalBytes; }
  entryCount(): number { return this.map.size; }

  dirtyEntries(): Array<[string, CacheEntry]> {
    const out: Array<[string, CacheEntry]> = [];
    for (const [k, v] of this.map) if (v.dirty) out.push([k, v]);
    return out;
  }

  /** After a persist: remove fully-deleted entries, clear dirty flags on the rest. */
  commitDirty(entries: ReadonlyArray<[string, CacheEntry]>): void {
    for (const [k, e] of entries) {
      if (e.deleted) this.unset(k);
      else e.dirty = false;
    }
  }

  /** Drop every clean entry. Returns how many were dropped. */
  dropClean(): number {
    let dropped = 0;
    for (const [k, e] of [...this.map]) {
      if (!e.dirty) { this.unset(k); dropped++; }
    }
    return dropped;
  }

  private set(filename: string, entry: CacheEntry): void {
    const prev = this.map.get(filename);
    if (prev) this.totalBytes -= prev.sizeBytes;
    this.map.set(filename, entry);
    this.totalBytes += entry.sizeBytes;
  }

  private unset(filename: string): void {
    const prev = this.map.get(filename);
    if (!prev) return;
    this.map.delete(filename);
    this.totalBytes -= prev.sizeBytes;
  }

  private touch(filename: string, entry: CacheEntry): void {
    this.map.delete(filename);
    this.map.set(filename, entry);
  }

  private evictIfOverBudget(): void {
    if (this.totalBytes <= this.opts.maxBytes) return;
    for (const [k, e] of this.map) {
      if (this.totalBytes <= this.opts.maxBytes) break;
      if (e.dirty) continue;
      this.unset(k);
      this.opts.logger.debug("blob.cache.evict", { filename: k, bytes: e.sizeBytes });
      this.opts.metrics.counter("gitstore.cache.evict").inc(1);
    }
  }
}
