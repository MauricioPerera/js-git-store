# js-git-store

Git-backed storage adapters for [js-doc-store](https://github.com/MauricioPerera/js-doc-store) and [js-vector-store](https://github.com/MauricioPerera/js-vector-store). Use a git repository as your versioned, content-addressable, edge-deployable database substrate.

Zero runtime dependencies. Node 20+. TypeScript strict.

## Status

**Pre-v0.1.** The artifacts in this repo are the execution contract for a coding agent to build the implementation. No code has been written yet. Read the contracts below, in order, and use them to drive the build.

## What it is

Two pluggable `StorageAdapter` implementations that persist `js-doc-store` collections and `js-vector-store` vectors in a git repo using a "tree first, blob on demand" layout:

- One orphan `index` branch — small, cloned shallow, always local — holds metadata + partitions
- One `main` content branch — large, cloned with `--filter=blob:none` — holds full documents and vectors, fetched on demand

The pattern is already proven in production at [a2e-skills](https://github.com/MauricioPerera/a2e-skills) (content catalog) and [a2e-shell](https://github.com/MauricioPerera/a2e-shell) (catalog cache). This project generalizes it into a reusable library.

## Why it matters

- **Versioned by construction**: every write is a commit, every state is a SHA
- **Distributed**: clone = replica, no server needed
- **Branches**: dev vs prod, or embedding-model-v1 vs v2, or experiment branches
- **Audit**: signed commits, full history, diff per field
- **Edge-deployable**: eventually (v2.0) runs inside CF Workers via GitHub REST

For read-heavy domains with review-style writes (knowledge bases, config stores, versioned RAG), this is the JS-native, zero-dep, git-native substrate that doesn't currently exist.

For write-heavy or latency-sensitive domains (telemetry, live sessions, high-freq analytics), this is the wrong tool. See `SPECIFICATION.md` § 6 for the honest scale ceiling.

## How to use this repo if you're an AI coding agent

1. Read `CONTRACT.md` — execution contract, 7 sections, binary acceptance criteria
2. Read `SPECIFICATION.md` — the technical "why" behind the contract
3. Read `ARCHITECTURE.md` — module layout, data flow, error model
4. Read `API.md` — public surface the adapters expose
5. Read `TEST-PLAN.md` — concrete test scenarios you must implement
6. Read `ROADMAP.md` — what's in scope for v0.1 vs later phases
7. Cross-reference `js-doc-store` and `js-vector-store` sources for the exact StorageAdapter interface you must satisfy
8. Cross-reference `a2e-shell/src/catalog/cache.ts` and `a2e-skills/tools/*` for the pattern you're generalizing

Write the code under `src/`, tests under `tests/`, examples under `examples/`, per the contract's line limits. Do not deviate from the hard constraints without stopping and reporting.

## How to use this repo if you're a human

Same as above. The artifacts are self-describing.

## Repository layout

```
.
├── CONTRACT.md              # Execution contract — READ FIRST
├── SPECIFICATION.md         # Technical spec — the "why"
├── ARCHITECTURE.md          # Module layout + data flow
├── API.md                   # Public surface
├── TEST-PLAN.md             # Concrete test scenarios
├── ROADMAP.md               # Phased delivery plan
├── README.md                # This file
├── LICENSE                  # MIT (convention — change as needed)
├── package.json             # Starter metadata, no deps yet
├── tsconfig.json            # Strict TS config
├── .gitignore
├── src/                     # (empty) implementation goes here
├── tests/                   # (empty) tests go here
└── examples/                # (empty) reference integrations go here
```

## Relationship to related projects

- [js-doc-store](https://github.com/MauricioPerera/js-doc-store) — host library for documents; adapter target
- [js-vector-store](https://github.com/MauricioPerera/js-vector-store) — host library for vectors; adapter target
- [a2e-shell](https://github.com/MauricioPerera/a2e-shell) — HTTP server for LLM agents; uses this pattern in its catalog cache
- [a2e-skills](https://github.com/MauricioPerera/a2e-skills) — knowledge catalog for LLM agents; migration target for v0.1

## License

MIT (see LICENSE).
