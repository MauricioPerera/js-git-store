import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

/**
 * Atomically write data to a path: write to a sibling tmp file, fsync, rename.
 * The rename is atomic within the same filesystem. Callers MUST ensure target
 * and tmp live on the same filesystem (i.e., a sibling path, as used here).
 */
export async function atomicWriteFile(
  target: string,
  data: Buffer | string,
): Promise<void> {
  const dir = dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await fs.open(tmp, "wx");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}
