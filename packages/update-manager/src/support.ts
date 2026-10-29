import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { BackgroundUpdateStatus } from "./status.js";
import { INSTALLER_FILES_PATH, parseInstallerFiles } from "./installer-files.js";

export function automaticUpdateUnavailableReason(
  platform: NodeJS.Platform,
  installation: BackgroundUpdateStatus["installation"],
): string | null {
  return platform === "win32" && installation === "macos-dmg"
    ? "This Windows session cannot update a macOS installation; use its original macOS channel and application directory."
    : null;
}
/** Local capability only; downloading and validating both original tools still happens before handoff. */
export async function windowsInstallerRecoveryUnavailable(
  installRoot: string,
  version: string,
): Promise<string | null> {
  try {
    const file = path.join(installRoot, INSTALLER_FILES_PATH),
      info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
      throw new Error("invalid capability");
    const files = parseInstallerFiles(await readFile(file, "utf8"));
    if (files.version !== version) throw new Error("capability version mismatch");
    return null;
  } catch {
    return "This installation has no matching original-installer recovery capability; update manually using the original installer channel and original directory.";
  }
}
