import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requestDesktopThreadCatalogRefresh } from "@codexhost/desktop-control";

/** Notify only the Desktop sharing these native files; absence or failure is a no-op. */
export async function refreshNativeThreadCatalog(
  environment: NodeJS.ProcessEnv,
  nativeHome: string,
  desktopHome = environment.CODEX_HOME ?? path.join(environment.HOME ?? os.homedir(), ".codex"),
): Promise<void> {
  if (!environment.CODEXHOST_CONTROL_PORT || !environment.CODEXHOST_CONTROL_NONCE) return;
  try {
    const [source, target] = await Promise.all([realpath(nativeHome), realpath(desktopHome)]);
    if (source !== target) return;
    await requestDesktopThreadCatalogRefresh(environment);
  } catch {
    // Directory refresh cannot affect the committed Session.
  }
}
