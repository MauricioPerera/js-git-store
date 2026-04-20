export type ErrorCode =
  | "GIT_COMMAND_FAILED"
  | "BLOB_FETCH_TIMEOUT"
  | "AUTH_MISSING"
  | "BRANCH_NOT_FOUND"
  | "LOCK_TIMEOUT"
  | "CONCURRENT_WRITE"
  | "BACKPRESSURE"
  | "ADAPTER_CLOSED"
  | "INVALID_CONFIG"
  | "INVALID_INDEX_SCHEMA"
  | "CACHE_CORRUPTED"
  | "NOT_IMPLEMENTED_YET";

export class GitStoreError extends Error {
  readonly code: ErrorCode;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "GitStoreError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
