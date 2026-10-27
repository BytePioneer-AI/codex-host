import type { RendererHostRouting } from "@codexhost/desktop-control/renderer-bindings";
import { hostThreadIdSchema, parseThreadReference } from "@codexhost/shared-contracts";
import { installCodexThreadClipboard } from "./codex-thread-clipboard.js";
import { createRendererThreadBridge } from "./renderer-thread-bridge.js";
import { openRendererThread } from "./renderer-fork-control.js";
import {
  SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_SELECTOR,
  threadIdFromSidebarRowElement,
} from "./renderer-sidebar-agent-icons.js";

/** Native menus live outside the DOM; bind their clipboard action to a verified sidebar gesture. */
export function installRendererThreadLinks(
  routing: () => RendererHostRouting | undefined,
): () => void {
  if (typeof document.createElement !== "function") return () => {};
  const bridge = createRendererThreadBridge({
    routing,
    messages: window,
    hostIds: () =>
      [...document.querySelectorAll(SIDEBAR_THREAD_ROW_SELECTOR)]
        .map((row) => row.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE))
        .filter((id): id is string => !!id),
  });
  let context: { threadId: string; hostId: string; expires: number } | undefined;
  let disposed = false;
  let clipboardDispose: (() => void) | undefined;
  let clipboardLoading: Promise<void> | undefined;
  const reset = () => {
    context = undefined;
  };
  const report = (message: string) => {
    if (disposed) return;
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    status.textContent = message;
    Object.assign(status.style, {
      position: "fixed",
      bottom: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      padding: "10px 16px",
      borderRadius: "8px",
      background: "#202020",
      color: "#fff",
      maxWidth: "80vw",
    });
    document.body.append(status);
    setTimeout(() => status.remove(), 6000);
  };
  const ensureClipboard = () => {
    if (disposed || clipboardDispose || clipboardLoading) return;
    clipboardLoading = installCodexThreadClipboard(window, async (text) => {
      const selected = context;
      if (disposed || !selected || selected.expires < Date.now()) return text;
      let reference;
      try {
        reference = parseThreadReference(text);
      } catch {
        return text;
      }
      if (
        reference.machineId ||
        reference.threadId !== selected.threadId ||
        (reference.hostId ?? "local") !== selected.hostId
      )
        return text;
      reset();
      try {
        return await bridge.reference(selected.threadId, selected.hostId);
      } catch (error) {
        report(error instanceof Error ? error.message : String(error));
        throw error;
      }
    })
      .then((dispose) => {
        if (disposed) dispose?.();
        else clipboardDispose = dispose ?? undefined;
      })
      .catch(() => undefined)
      .finally(() => {
        clipboardLoading = undefined;
      });
  };
  const onContextMenu = (event: MouseEvent) => {
    reset();
    const row =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)
        : null;
    const threadId = row && threadIdFromSidebarRowElement(row);
    const hostId = row?.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE);
    if (!threadId || !hostId) return;
    context = { threadId, hostId, expires: Date.now() + 60_000 };
    ensureClipboard();
  };
  const onClick = (event: MouseEvent) => {
    const anchor =
      event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    const href = anchor?.getAttribute("href");
    if (!href || !/^(thread:\/\/|codex:\/\/threads\/)/u.test(href) || !href.includes("machineId="))
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void (async () => {
      const reference = parseThreadReference(href);
      const hostId = await bridge.hostFor(reference);
      if (!disposed)
        await openRendererThread(hostThreadIdSchema.parse(reference.threadId), { hostId });
    })().catch((error: unknown) => report(error instanceof Error ? error.message : String(error)));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") reset();
  };
  document.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("pointerdown", reset, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  const refresh = () => {
    ensureClipboard();
    void bridge.refresh().catch(() => undefined);
  };
  const interval = setInterval(refresh, 15_000);
  refresh();
  return () => {
    disposed = true;
    reset();
    clearInterval(interval);
    clipboardDispose?.();
    bridge.dispose();
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("pointerdown", reset, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
}
