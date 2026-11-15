import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Publish a complete record without replacing an existing lock, including on Windows. */
export async function createLockFile(file: string, content: string): Promise<void> {
  const start = Math.round(Date.now() - process.uptime() * 1_000);
  const temporary = `${file}.publish-${process.pid}-${start}-${randomUUID()}`;
  const handle = await open(temporary, "wx", constants.S_IRUSR | constants.S_IWUSR);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, file);
  } finally {
    // Publication commits ownership; a leftover link is reclaimed when its process dies.
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * A hard link pins the inspected inode. Only a snapshot with exactly two links
 * (the canonical lock and itself) may remove it, after checking the canonical
 * path still names that inode. Keep the snapshot until removal completes.
 */
export async function removeStaleLock(
  file: string,
  inspected: string,
  ownerIsLive: (pid: number, processStartedAt: string) => boolean,
): Promise<void> {
  const prefix = `${path.basename(file)}.`;
  for (const name of await readdir(path.dirname(file))) {
    if (!name.startsWith(`${prefix}claim-`) && !name.startsWith(`${prefix}publish-`)) continue;
    const [, pidText, startText] = name.slice(prefix.length).split("-");
    const pid = Number(pidText);
    const start = Number(startText);
    if (
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      Number.isSafeInteger(start) &&
      start > 0 &&
      !ownerIsLive(pid, new Date(start).toISOString())
    ) {
      await rm(path.join(path.dirname(file), name), { force: true });
    }
  }
  const start = Math.round(Date.now() - process.uptime() * 1_000);
  const snapshot = `${file}.claim-${process.pid}-${start}-${randomUUID()}`;
  try {
    await link(file, snapshot);
    if ((await readFile(snapshot, "utf8")) !== inspected) throw new Error("Lock changed");
    const pinned = await stat(snapshot, { bigint: true });
    if (pinned.nlink !== 2n) throw new Error("Concurrent lock takeover");
    const current = await stat(file, { bigint: true });
    if (current.dev !== pinned.dev || current.ino !== pinned.ino) throw new Error("Lock changed");
    await rm(file);
  } finally {
    await rm(snapshot, { force: true });
  }
}
