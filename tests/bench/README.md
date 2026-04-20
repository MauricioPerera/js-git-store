# Benchmarks

Smoke benchmarks against a local `file://` bare repo. They isolate the
adapter's costs (clone, fetch, cache, commit) — no network, no remote git
server. Use the `e2e:github*` and `soak` scripts for end-to-end measurements
that include the GitHub round trip.

## Running

```bash
npm run bench               # all four, sequentially
npm run bench:cold-read     # 1k docs: cold clone + warm reopen
npm run bench:vector-load   # 10k × 768 vectors: cold load + hot reads
npm run bench:persist       # write+commit latency at batch 1/10/100
npm run bench:cache-eviction # LRU pressure, eviction accounting
```

Each benchmark is one file under `tests/bench/`. They are not part of the
test suite — `npm test` does not run them.

## Gating

The first two (`cold-read`, `vector-load`) accept `BENCH_GATE=1` to enforce
the latency budgets from CONTRACT.md / TEST-PLAN.md. CI does not enforce
them by default — git-spawn cost varies wildly across platforms (Linux ~5
ms, Windows ~100–300 ms) and the budgets assume Linux.

```bash
BENCH_GATE=1 npm run bench:cold-read
```

## Sizing

Most benchmarks accept env vars to scale the workload:

| Bench            | Var(s)              | Default        |
|------------------|---------------------|----------------|
| vector-load      | `BENCH_N`, `BENCH_D`| 10000, 768     |
| cache-eviction   | `BENCH_N`, `BENCH_PAYLOAD` | 200, 16384 |

## What each one tells you

- **cold-read** — baseline clone-and-read latency. Regresses if the git
  wrapper or `preload()` adds overhead.
- **vector-load** — same shape but on a single large binary blob; catches
  regressions in the binary path (`readBin`, `readBinShared`).
- **persist-throughput** — per-doc cost as batch size grows; the gap
  between batch=1 and batch=100 measures the fixed git-spawn overhead.
- **cache-eviction** — verifies LRU correctness under pressure (resident
  bytes ≤ cap, oldest entries gone) and gives a hit-vs-miss latency ratio.
