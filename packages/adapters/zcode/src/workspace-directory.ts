import { realpathSync, statSync } from "node:fs";

/** Compare actual directories, not spellings; Windows can be case-sensitive too. */
export function sameWorkspaceDirectory(left: string, right: string): boolean {
  try {
    const leftPath = realpathSync(left);
    const rightPath = realpathSync(right);
    const leftStat = statSync(leftPath, { bigint: true });
    const rightStat = statSync(rightPath, { bigint: true });
    if (!leftStat.isDirectory() || !rightStat.isDirectory()) return false;
    if (leftPath === rightPath) return true;
    // realpath does not promise case conversion. File IDs handle case aliases,
    // junctions and drive/UNC spellings without accepting a different directory.
    // Some filesystems expose no useful inode; do not equate their zero IDs.
    return leftStat.ino !== 0n && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}
