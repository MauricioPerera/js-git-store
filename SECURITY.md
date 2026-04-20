# SECURITY — js-git-store

## Threat model

The adapter runs in-process with full trust of its embedding application. It is NOT a security boundary — a malicious caller can read every file on disk the process can read.

The adapter IS responsible for:

1. **Never leaking auth tokens** through log output, error messages, thrown errors, or cache filenames.
2. **Never executing caller-controlled input as a shell command**. All git invocations use `spawn("git", argv, { shell: false })` with argv arrays.
3. **Atomic writes** so a crash mid-`persist()` cannot leave a half-written blob that a reader mistakes for complete.
4. **Not silently swallowing** remote rejections (non-fast-forward, auth failure, SHA mismatch).

## Reporting vulnerabilities

Open a private security advisory on the repository, or email the maintainer directly. Do not file public issues for security reports.

## Token handling

When `authEnvVar` is set:

- The adapter reads `process.env[authEnvVar]` at each git call. Rotation is supported: update the env var, subsequent calls use the new value.
- The token is NEVER written to disk. Not to `.git/config`, not to the cache dir, not as a filename, not as part of a commit.
- The token is sent to git exclusively via the `-c http.extraHeader="Authorization: Basic <base64>"` mechanism. The header line is ephemeral to the spawned git process.
- All stderr is passed through a redactor that replaces both the raw token and its `x-access-token:<token>` base64 form with `***`. The argv portion of any thrown `GitStoreError.message` is redacted by the same function.
- If the env var is unset when auth is actually needed (remote clone or push), the adapter throws `AUTH_MISSING` before invoking git — so no empty-credential request is ever sent.

### What this protects against

- A misconfigured logger level that prints stderr.
- A `console.error(err)` on a caught `GitStoreError`.
- A crash dump that includes stack traces with error messages.
- A `git` stderr that echoes the URL with embedded credentials (it cannot, because we never embed them).

### What this does NOT protect against

- **Process memory dump** — the token lives in `process.env` and as a derived base64 string in closure scope for the duration of calls. A memory-reading attacker with local privileges defeats any in-process scheme.
- **A malicious `logger` implementation** that serializes the full options object it receives. The adapter trusts the injected logger.
- **A malicious `commitMessage`** function that includes the token. Don't put tokens in commit messages.
- **A subverted `git` binary** on `PATH`. The adapter trusts the system git.

## Local cache dir trust

The `localCacheDir` is assumed to be writable only by the owning process user. The file lock and the clones live there. On shared systems, an attacker with write access to `localCacheDir` can:

- Replace `.lock` to force deadlocks
- Modify cloned content before the adapter reads it
- Plant malicious `.git/hooks/` (git respects hooks from cloned `.git/` — this adapter runs `git gc` which may trigger them)

**Mitigation**: put `localCacheDir` under a user-private directory. Avoid world-writable paths.

## Remote URL trust

The `repoUrl` is invoked directly as a git remote. For `file://`, the adapter has no way to enforce that the remote is not malicious — a hostile bare repo can serve a tree whose content causes git to do unexpected things (e.g., symlinks that escape the worktree with older git).

**Mitigation**: only point `repoUrl` at remotes you control or trust. Use HTTPS with pinned hostnames in production, not `file://` to untrusted paths.

## Known limitations

- No integrity checksum on cached blobs (`CACHE_CORRUPTED` error code is defined but never raised). An attacker with write access to `localCacheDir` can corrupt cache entries without detection. Mitigation: private cache dir.
- `refresh()` with `{ force: true }` silently discards local un-pushed commits. This is intentional (the non-force path refuses), but a caller passing `force: true` unconditionally loses data.
- `git gc` scheduling runs `git gc --auto --quiet` on local worktrees. If a worktree is corrupt, gc may propagate the corruption. Mitigation: `gcIntervalMs` is off by default; enable only when the caller monitors logs for `gc.background.error`.

## Validated protections

- **Validated against real GitHub with private repo** (2026-04-19): auth header travels, token redacted from forced errors (`BRANCH_NOT_FOUND` provoked with non-existent branch, error message contained no token).
- **52-test integration suite** covers: token redaction, `AUTH_MISSING` fail-fast, `CONCURRENT_WRITE` on non-fast-forward, config validation rejecting bad inputs, idempotent `close()` releasing the lock file, `persist()` draining on shutdown.
