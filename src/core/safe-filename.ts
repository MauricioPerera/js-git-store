import { GitStoreError } from "./types.js";

/**
 * Reject filenames that would escape the worktree or target absolute paths.
 * Called on every public write and on every internal stage/read path.
 * Invariants: no `..` segments, no `.` segments, no leading `/` or `\`, no
 * drive-letter prefixes, no null bytes, no empty string.
 * Throws `INVALID_CONFIG` on violation.
 */
export function assertSafeFilename(filename: string): void {
  if (typeof filename !== "string" || filename.length === 0) {
    throw new GitStoreError("INVALID_CONFIG", "filename must be a non-empty string");
  }
  if (filename.includes("\0")) {
    throw new GitStoreError("INVALID_CONFIG", "filename must not contain null bytes");
  }
  if (filename.startsWith("/") || filename.startsWith("\\")) {
    throw new GitStoreError("INVALID_CONFIG", `filename must be relative (got "${filename}")`);
  }
  if (/^[a-zA-Z]:/.test(filename)) {
    throw new GitStoreError("INVALID_CONFIG", `filename must not be a drive-letter path (got "${filename}")`);
  }
  for (const p of filename.split(/[/\\]/)) {
    if (p === ".." || p === ".") {
      throw new GitStoreError("INVALID_CONFIG", `filename must not contain "." or ".." segments (got "${filename}")`);
    }
  }
}
