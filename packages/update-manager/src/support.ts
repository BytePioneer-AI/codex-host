import type { BackgroundUpdateStatus } from "./status.js";

/** Current execution policy, shared by discovery and every start entry. No caller override. */
export function automaticUpdateUnavailableReason(
  platform: NodeJS.Platform,
  installation: BackgroundUpdateStatus["installation"],
): string | null {
  if (platform !== "win32") return null;
  if (installation === "npm") {
    return "Windows npm automatic updates require verified activation ownership and pre-execution whole-tree isolation. Update manually through npm using the original global prefix and exact release version; do not switch installation channels.";
  }
  if (installation === "windows-installer") {
    return "Windows installer automatic updates require verified original-channel recovery; use the manual installer in the original directory.";
  }
  return "This Windows session cannot update a macOS installation; use its original macOS channel and application directory.";
}
