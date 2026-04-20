export interface Counter {
  inc(by?: number, labels?: Record<string, string>): void;
}

export interface Histogram {
  observe(valueMs: number, labels?: Record<string, string>): void;
}

export interface MetricsCollector {
  counter(name: string): Counter;
  histogram(name: string): Histogram;
}

class NoopCounter implements Counter { inc(): void {} }
class NoopHistogram implements Histogram { observe(): void {} }

export const noopMetrics: MetricsCollector = {
  counter: () => new NoopCounter(),
  histogram: () => new NoopHistogram(),
};

export interface MetricSample {
  name: string;
  kind: "counter" | "histogram";
  value: number;
  labels?: Record<string, string>;
  count?: number;
}

/**
 * In-memory metrics collector. Stores per-(name, labelset) totals. Useful for
 * tests and for applications that want to scrape the adapter's counters
 * without pulling a Prometheus client dep.
 */
export class InMemoryMetrics implements MetricsCollector {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, { sum: number; count: number }>();

  counter(name: string): Counter {
    return {
      inc: (by = 1, labels) => {
        const k = key(name, labels);
        this.counters.set(k, (this.counters.get(k) ?? 0) + by);
      },
    };
  }

  histogram(name: string): Histogram {
    return {
      observe: (valueMs, labels) => {
        const k = key(name, labels);
        const cur = this.histograms.get(k) ?? { sum: 0, count: 0 };
        cur.sum += valueMs; cur.count += 1;
        this.histograms.set(k, cur);
      },
    };
  }

  snapshot(): MetricSample[] {
    const out: MetricSample[] = [];
    for (const [k, value] of this.counters) {
      const { name, labels } = parseKey(k);
      const s: MetricSample = { name, kind: "counter", value };
      if (labels) s.labels = labels;
      out.push(s);
    }
    for (const [k, { sum, count }] of this.histograms) {
      const { name, labels } = parseKey(k);
      const s: MetricSample = { name, kind: "histogram", value: sum, count };
      if (labels) s.labels = labels;
      out.push(s);
    }
    return out;
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }
}

function key(name: string, labels?: Record<string, string>): string {
  if (!labels) return name;
  const pairs = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return pairs.length === 0 ? name : `${name}|${pairs.map(([k, v]) => `${k}=${v}`).join(",")}`;
}

function parseKey(k: string): { name: string; labels?: Record<string, string> } {
  const idx = k.indexOf("|");
  if (idx === -1) return { name: k };
  const name = k.slice(0, idx);
  const labels: Record<string, string> = {};
  for (const pair of k.slice(idx + 1).split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { name, labels };
}
