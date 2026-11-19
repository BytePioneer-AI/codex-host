/**
 * Enter the sign-in page once this browser's token stops being valid.
 *
 * A dropped connection does not say why it dropped, and a device that was offline when its token
 * was replaced never saw it happen, so each foreground reconnect phase asks the server. Only an explicit 401
 * leaves the page: an unreachable server keeps the current content and connection status.
 */
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { disableNotifications } from "./notifications.ts";

const PROBE_INTERVAL_MS = 5_000;

export const computerOffline = createSnapshotStore(false);

let tokenRenewals = 0;
const renewalListeners = new Set<() => void>();

/**
 * Pause 401 expiry probes across an intentional token rotation so closing old sockets does not
 * reload the page before the response sets the replacement cookie.
 */
export async function runWithTokenRenewal<T>(operation: () => Promise<T>): Promise<T> {
  tokenRenewals += 1;
  if (tokenRenewals === 1) {
    for (const listener of renewalListeners) listener();
  }
  try {
    return await operation();
  } finally {
    tokenRenewals -= 1;
    if (tokenRenewals === 0) {
      for (const listener of renewalListeners) listener();
    }
  }
}

/**
 * @param state - the connection state to watch.
 * @returns a function that stops watching.
 */
export function watchAuthentication(state: ConnectionHandle["state"]): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let stopped = false;
  let unreachable = 0;
  let visible = document.visibilityState !== "hidden";
  const canProbe = () =>
    !stopped &&
    tokenRenewals === 0 &&
    visible &&
    document.visibilityState !== "hidden" &&
    state.getSnapshot() === "connecting";
  const reset = () => {
    clearTimeout(timer);
    request?.abort();
    request = undefined;
    unreachable = 0;
    computerOffline.set(false);
  };
  const probe = async (): Promise<void> => {
    if (request !== undefined || !canProbe()) return;
    const current = new AbortController();
    request = current;
    clearTimeout(timer);
    timer = setTimeout(() => current.abort(), PROBE_INTERVAL_MS);
    const started = Date.now();
    let reachable = false;
    let unauthorized = false;
    try {
      const response = await fetch("api/auth/status", {
        credentials: "same-origin",
        cache: "no-store",
        signal: current.signal,
      });
      if (!current.signal.aborted) {
        unauthorized = response.status === 401;
        reachable = response.status === 200;
      }
    } catch {
      // A network error or timeout means Web is unreachable, not that the token expired.
    }
    // A suspended or replaced probe cannot publish evidence or reload the page.
    if (request !== current || !canProbe()) return;
    request = undefined;
    clearTimeout(timer);
    if (unauthorized) {
      window.location.reload();
      return;
    }
    if (reachable) {
      unreachable = 0;
      computerOffline.set(false);
    }
    // Count failed five-second windows, so an immediate gateway error is not an offline notice.
    timer = setTimeout(
      () => {
        if (!canProbe()) return;
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
    if (!canProbe()) reset();
    else void probe();
  };
  const visibilityChanged = () => {
    const next = document.visibilityState !== "hidden";
    if (next === visible) return;
    visible = next;
    reset();
    changed();
  };
  const shown = (event: PageTransitionEvent) => {
    if (event.persisted) visibilityChanged();
  };
  const unsubscribe = state.subscribe(changed);
  renewalListeners.add(changed);
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("pageshow", shown);
  changed();
  return () => {
    stopped = true;
    reset();
    unsubscribe();
    renewalListeners.delete(changed);
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("pageshow", shown);
  };
}

/** Sign this browser out and show the sign-in page; a signed-out device must not keep notifying. */
export async function signOut(): Promise<void> {
  await disableNotifications().catch(() => undefined);
  const response = await fetch("api/auth/logout", { method: "POST", credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  window.location.reload();
}
