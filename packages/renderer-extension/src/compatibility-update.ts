import type { RendererModelClient } from "./renderer-model-client.js";

export type CompatibilityUpdateOutcome = "update-started" | "current" | "unavailable";

export async function startCompatibilityUpdate(
  client: Pick<RendererModelClient, "checkUpdate" | "startUpdate"> | null,
): Promise<CompatibilityUpdateOutcome> {
  if (!client) return "unavailable";
  try {
    const check = await client.checkUpdate();
    if (check.updateAvailable && check.installationAvailable) {
      void client.startUpdate().catch(() => undefined);
      return "update-started";
    }
    if (
      check.error === null &&
      check.latestVersion !== null &&
      check.currentVersion === check.latestVersion
    ) {
      return "current";
    }
  } catch {
    // The Launcher presents the bounded fallback instead of exposing Host errors.
  }
  return "unavailable";
}
