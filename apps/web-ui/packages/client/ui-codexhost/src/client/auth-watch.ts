/**
 * Enter the sign-in page once this browser's token stops being valid.
 *
 * A dropped connection does not say why it dropped, and a device that was offline when its token
 * was replaced never saw it happen, so every reconnect phase asks the server. Only an explicit 401
 * leaves the page: an unreachable server keeps the current content and connection status.
 */
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { disableNotifications } from "./notifications.ts";

const PROBE_INTERVAL_MS = 5_000;

export const computerOffline = createSnapshotStore(false);

/**
 * @param state - the connection state to watch.
 * @returns a function that stops watching.
 */
export function watchAuthentication(state: ConnectionHandle["state"]): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let probing = false;
  let stopped = false;
  let unreachable = 0;
  const probe = async (): Promise<void> => {
    if (probing || stopped || state.getSnapshot() !== "connecting") return;
    probing = true;
    clearTimeout(timer);
    const started = Date.now();
    let reachable = false;
    try {
      const response = await fetch("api/auth/status", {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(PROBE_INTERVAL_MS),
      });
      if (response.status === 401) {
        window.location.reload();
        return;
      }
      reachable = response.status === 200;
    } catch {
      // A network error or timeout means Web is unreachable, not that the token expired.
    }
    probing = false;
    if (stopped || state.getSnapshot() !== "connecting") return;
    if (reachable) {
      unreachable = 0;
      computerOffline.set(false);
    }
    // Count failed five-second windows, so an immediate gateway error is not an offline notice.
    timer = setTimeout(
      () => {
        if (!reachable) {
          unreachable += 1;
          computerOffline.set(unreachable >= 2);
        }
        void probe();
      },
      Math.max(0, PROBE_INTERVAL_MS - (Date.now() - started)),
    );
  };
  const changed = () => {
    if (state.getSnapshot() !== "connecting") {
      clearTimeout(timer);
      unreachable = 0;
      computerOffline.set(false);
    } else void probe();
  };
  const unsubscribe = state.subscribe(changed);
  changed();
  return () => {
    stopped = true;
    clearTimeout(timer);
    computerOffline.set(false);
    unsubscribe();
  };
}

/** Sign this browser out and show the sign-in page; a signed-out device must not keep notifying. */
export async function signOut(): Promise<void> {
  await disableNotifications().catch(() => undefined);
  const response = await fetch("api/auth/logout", { method: "POST", credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  window.location.reload();
}
