import { hostThreadIdSchema, type HostThreadId } from "@codexhost/shared-contracts";
import { loadCodexNativeServices } from "./codex-native-services.js";

interface NativeNavigationBus {
  handlers: Map<string, unknown>;
  dispatchHostMessage(message: { type: "navigate-to-route"; path: string }): void;
}

function isNavigationBus(value: unknown): value is NativeNavigationBus {
  if (typeof value !== "object" || value === null) return false;
  const bus = value as NativeNavigationBus;
  return (
    bus.handlers instanceof Map &&
    bus.handlers.has("navigate-to-route") &&
    typeof bus.dispatchHostMessage === "function"
  );
}

/** Open a local chat through Desktop's router, including chats absent from the sidebar. */
export async function openCodexLocalThread(
  threadId: HostThreadId,
  signal: AbortSignal,
  ownerWindow: Window = window,
): Promise<void> {
  signal.throwIfAborted();
  const path = `/local/${encodeURIComponent(hostThreadIdSchema.parse(threadId))}`;
  const bus = await loadCodexNativeServices(ownerWindow, isNavigationBus);
  signal.throwIfAborted();
  if (!bus) throw new Error("Codex chat navigation is unavailable");

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      ownerWindow.clearInterval(poll);
      ownerWindow.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const arrived = () => ownerWindow.location.pathname === path;
    // Native navigation may dismiss settings and abort its page scope first.
    const onAbort = () => finish(arrived() ? undefined : signal.reason);
    const poll = ownerWindow.setInterval(() => {
      if (arrived()) finish();
    }, 25);
    const timeout = ownerWindow.setTimeout(
      () => finish(new Error("Codex did not open the requested chat")),
      5_000,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      bus.dispatchHostMessage({ type: "navigate-to-route", path });
      if (arrived()) finish();
    } catch (error) {
      finish(error);
    }
  });
}
