import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";
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

function hasArrived(ownerWindow: Window): boolean {
  const paths = ["/automations", "/scheduled"];
  const pages = ownerWindow.document.querySelectorAll('[data-app-shell-active-page="true"]');
  // Desktop's tab router keeps window.location at /index.html. Only the active
  // page's committed LocationContext acknowledges navigation, not a retained tab.
  if (pages.length > 0) {
    const page = pages[0];
    if (pages.length !== 1 || !page) return false;
    const fiberKey = Object.keys(page).find((key) => key.startsWith("__reactFiber$"));
    if (!fiberKey) return false;
    for (const ancestor of committedReactAncestors(Reflect.get(page, fiberKey))) {
      const props = ancestor.memoizedProps as {
        value?: { navigationType?: unknown; location?: { pathname?: unknown } };
      } | null;
      const value = props?.value;
      if (
        value?.navigationType === "POP" ||
        value?.navigationType === "PUSH" ||
        value?.navigationType === "REPLACE"
      ) {
        return (
          typeof value.location?.pathname === "string" && paths.includes(value.location.pathname)
        );
      }
    }
    return false;
  }
  return paths.includes(ownerWindow.location.pathname);
}

/** Desktop 26.1023 redirects /automations to /scheduled when its new task UI is enabled. */
export async function openCodexSchedules(
  signal: AbortSignal,
  ownerWindow: Window = window,
): Promise<void> {
  signal.throwIfAborted();
  const bus = await loadCodexNativeServices(ownerWindow, isNavigationBus);
  signal.throwIfAborted();
  if (!bus) throw new Error("Codex navigation is unavailable");

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
    const arrived = () => hasArrived(ownerWindow);
    // Native navigation may dismiss settings and abort its page scope first.
    const onAbort = () => finish(arrived() ? undefined : signal.reason);
    const poll = ownerWindow.setInterval(() => {
      if (arrived()) finish();
    }, 25);
    const timeout = ownerWindow.setTimeout(
      () => finish(new Error("Codex did not open the requested page")),
      5_000,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      bus.dispatchHostMessage({ type: "navigate-to-route", path: "/automations" });
      if (arrived()) finish();
    } catch (error) {
      finish(error);
    }
  });
}
