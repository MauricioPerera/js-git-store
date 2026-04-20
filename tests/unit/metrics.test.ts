import { describe, expect, it } from "vitest";
import { InMemoryMetrics, noopMetrics } from "../../src/metrics.js";

describe("InMemoryMetrics", () => {
  it("accumulates counter increments", () => {
    const m = new InMemoryMetrics();
    m.counter("hits").inc();
    m.counter("hits").inc(4);
    const s = m.snapshot().find((x) => x.name === "hits");
    expect(s).toMatchObject({ kind: "counter", value: 5 });
  });

  it("tracks distinct label sets", () => {
    const m = new InMemoryMetrics();
    m.counter("req").inc(1, { route: "a" });
    m.counter("req").inc(2, { route: "b" });
    m.counter("req").inc(4, { route: "a" });
    const snap = m.snapshot();
    const a = snap.find((x) => x.name === "req" && x.labels?.["route"] === "a");
    const b = snap.find((x) => x.name === "req" && x.labels?.["route"] === "b");
    expect(a?.value).toBe(5);
    expect(b?.value).toBe(2);
  });

  it("histograms expose sum and count", () => {
    const m = new InMemoryMetrics();
    m.histogram("lat").observe(10);
    m.histogram("lat").observe(30);
    const s = m.snapshot().find((x) => x.name === "lat");
    expect(s).toMatchObject({ kind: "histogram", value: 40, count: 2 });
  });

  it("reset clears everything", () => {
    const m = new InMemoryMetrics();
    m.counter("a").inc();
    m.histogram("b").observe(1);
    m.reset();
    expect(m.snapshot()).toHaveLength(0);
  });
});

describe("noopMetrics", () => {
  it("never throws", () => {
    expect(() => {
      noopMetrics.counter("x").inc();
      noopMetrics.histogram("y").observe(1);
    }).not.toThrow();
  });
});
