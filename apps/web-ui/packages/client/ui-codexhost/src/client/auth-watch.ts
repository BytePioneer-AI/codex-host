/**
 * Enter the sign-in page once this browser's token stops being valid.
 *
 * A dropped connection does not say why it dropped, and a device that was offline when its token
 * was deleted never saw it happen, so every reconnect phase asks the server. Only an explicit 401
 * leaves the page: an unreachable server keeps the current content and connection status.
 */
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";

const PROBE_INTERVAL_MS = 5_000;

/**
 * @param state - the connection state to watch.
 * @returns a function that stops watching.
 */
export function watchAuthentication(state: ConnectionHandle["state"]): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let probing = false;
  let stopped = false;
  const probe = async (): Promise<void> => {
    if (probing || stopped || state.getSnapshot() !== "connecting") return;
    probing = true;
    clearTimeout(timer);
    try {
      const response = await fetch("api/auth/status", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        window.location.reload();
        return;
      }
    } catch {
      // Unreachable says nothing about the token.
    }
    probing = false;
    if (stopped || state.getSnapshot() !== "connecting") return;
    // Retries stay in "connecting" without a new state change, so keep asking meanwhile.
    timer = setTimeout(() => void probe(), PROBE_INTERVAL_MS);
  };
  const unsubscribe = state.subscribe(() => void probe());
  void probe();
  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
  };
}
