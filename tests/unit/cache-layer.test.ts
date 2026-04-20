import { describe, expect, it } from "vitest";
import { CacheLayer } from "../../src/core/cache-layer.js";
import { noopLogger } from "../../src/logger.js";
import { InMemoryMetrics } from "../../src/metrics.js";

function newLayer(maxBytes = 1024): { layer: CacheLayer; metrics: InMemoryMetrics } {
  const metrics = new InMemoryMetrics();
  const layer = new CacheLayer({ maxBytes, logger: noopLogger, metrics });
  return { layer, metrics };
}

describe("CacheLayer — sync read/write", () => {
  it("round-trips JSON", () => {
    const { layer } = newLayer();
    layer.writeJson("a.json", { v: 1 });
    expect(layer.readJson<{ v: number }>("a.json")).toEqual({ v: 1 });
  });

  it("round-trips binary", () => {
    const { layer } = newLayer();
    layer.writeBin("a.bin", Buffer.from([1, 2, 3]));
    const ab = layer.readBin("a.bin");
    expect(ab).not.toBeNull();
    expect(new Uint8Array(ab!)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns null for wrong variant", () => {
    const { layer } = newLayer();
    layer.writeJson("x.json", { v: 1 });
    expect(layer.readBin("x.json")).toBeNull();
    layer.writeBin("y.bin", Buffer.alloc(1));
    expect(layer.readJson("y.bin")).toBeNull();
  });

  it("returns null for missing files", () => {
    const { layer } = newLayer();
    expect(layer.readJson("nope.json")).toBeNull();
    expect(layer.readBin("nope.bin")).toBeNull();
  });
});

describe("CacheLayer — delete + invalidate", () => {
  it("delete marks tombstone and reads return null", () => {
    const { layer } = newLayer();
    layer.writeJson("a.json", { v: 1 });
    layer.delete("a.json");
    expect(layer.readJson("a.json")).toBeNull();
  });

  it("invalidate rejects dirty entries", () => {
    const { layer } = newLayer();
    layer.writeJson("a.json", { v: 1 });
    expect(layer.invalidate("a.json")).toBe(false);
    expect(layer.readJson("a.json")).toEqual({ v: 1 });
  });

  it("invalidate drops clean entries", () => {
    const { layer } = newLayer();
    layer.loaded("a.json", Buffer.from('{"v":1}'), true);
    expect(layer.invalidate("a.json")).toBe(true);
    expect(layer.readJson("a.json")).toBeNull();
  });
});

describe("CacheLayer — LRU touch semantics", () => {
  it("read refreshes recency; eviction drops the non-touched entry", () => {
    const { layer } = newLayer(100);
    layer.loaded("a.json", Buffer.alloc(40), false);
    layer.loaded("b.json", Buffer.alloc(40), false);
    layer.readBin("a.json");
    layer.loaded("c.json", Buffer.alloc(40), false);
    expect(layer.readBin("a.json")).not.toBeNull();
    expect(layer.readBin("b.json")).toBeNull();
    expect(layer.readBin("c.json")).not.toBeNull();
  });

  it("dirty entries survive eviction even over cap", () => {
    const { layer } = newLayer(50);
    layer.writeJson("dirty.json", { a: "keep" });
    layer.loaded("fat.bin", Buffer.alloc(200), false);
    expect(layer.readJson("dirty.json")).toEqual({ a: "keep" });
  });
});

describe("CacheLayer — byte accounting", () => {
  it("bytes() reflects running total with writes + overwrites + invalidates", () => {
    const { layer } = newLayer();
    expect(layer.bytes()).toBe(0);
    layer.loaded("a.bin", Buffer.alloc(100), false);
    expect(layer.bytes()).toBe(100);
    layer.loaded("b.bin", Buffer.alloc(50), false);
    expect(layer.bytes()).toBe(150);
    layer.loaded("a.bin", Buffer.alloc(10), false); // overwrite: 100 → 10
    expect(layer.bytes()).toBe(60);
    expect(layer.invalidate("b.bin")).toBe(true);
    expect(layer.bytes()).toBe(10);
  });

  it("entryCount() reports size", () => {
    const { layer } = newLayer();
    expect(layer.entryCount()).toBe(0);
    layer.writeJson("a.json", {});
    layer.writeJson("b.json", {});
    expect(layer.entryCount()).toBe(2);
  });
});

describe("CacheLayer — persist lifecycle helpers", () => {
  it("dirtyEntries + commitDirty: clean flags and unset tombstones", () => {
    const { layer } = newLayer();
    layer.writeJson("a.json", { v: 1 });
    layer.writeJson("b.json", { v: 2 });
    layer.delete("a.json");
    const dirty = layer.dirtyEntries();
    expect(dirty).toHaveLength(2);
    layer.commitDirty(dirty);
    expect(layer.readJson("a.json")).toBeNull();
    expect(layer.readJson("b.json")).toEqual({ v: 2 });
    expect(layer.dirtyEntries()).toHaveLength(0);
  });

  it("dropClean removes clean, preserves dirty", () => {
    const { layer } = newLayer();
    layer.loaded("clean.json", Buffer.from('{"v":1}'), true);
    layer.writeJson("dirty.json", { v: 2 });
    const dropped = layer.dropClean();
    expect(dropped).toBe(1);
    expect(layer.readJson("clean.json")).toBeNull();
    expect(layer.readJson("dirty.json")).toEqual({ v: 2 });
  });
});
