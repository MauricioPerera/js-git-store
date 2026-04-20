import { promises as fs } from "node:fs";

/** Whether a path is reachable by the current process. Wraps fs.access. */
export async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
