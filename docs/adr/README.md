# Architecture Decision Records

Short notes capturing **why** a non-trivial architectural choice was made.

## When to write one

Write an ADR when a change:

- crosses module boundaries (e.g. moves a responsibility from one layer to
  another, splits or merges modules);
- touches anything frozen in [STABILITY.md](../../STABILITY.md) or the
  contracts in [CONTRACT.md](../../CONTRACT.md);
- chooses one of two reasonable approaches whose trade-offs aren't
  obvious from the code (e.g. "spawn vs. REST", "in-process queue vs.
  external broker");
- reverses or supersedes a prior decision.

If the change is "rename a variable" or "fix a bug", skip the ADR — the
commit message is enough.

## Format

- Numbered sequentially: `NNNN-short-kebab-title.md`.
- Filled out from [template.md](template.md).
- Status of an ADR is one of: **Proposed**, **Accepted**, **Superseded by
  ADR-NNNN**, **Deprecated**.
- An ADR is never edited after being marked Accepted, except to flip its
  status to Superseded/Deprecated and link to the replacement. Mistakes
  get a new ADR that supersedes the old one.

## Index

| ID | Title | Status |
|---|---|---|
| [0001](0001-cache-layer-git-layer-split.md) | Split the adapter god-object into CacheLayer + GitLayer | Accepted |
