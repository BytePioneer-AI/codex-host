import { randomUUID } from "node:crypto";
import type { LocalPageHandle } from "./local-page-control.js";

/** Use the native browser's tab lifecycle, without embedding content into the chat origin. */
export async function openRendererLocalPage(
  execute: <T>(expression: string) => Promise<T>,
  url: string,
  targets: () => Promise<readonly { url: string }[]>,
): Promise<LocalPageHandle> {
  const conversationId = await execute<string | null>(
    "window.__codexhostRendererBindingProbeV1?.currentThreadId?.() ?? null",
  );
  if (!conversationId) throw new Error("Open a Codex task before starting verification");
  const browserTabId = `manual:${randomUUID()}`;
  const post = (value: object) =>
    execute<null>(`window.postMessage(${JSON.stringify(value)}, '*'); null`);
  try {
    await post({
      type: "toggle-browser-panel",
      conversationId,
      browserTabId,
      url,
      open: true,
      active: false,
      source: "browser_use",
      initiator: "codexhost_local_page",
    });
    const deadline = Date.now() + 5000;
    while (!(await targets()).some((target) => target.url === url)) {
      if (Date.now() >= deadline)
        throw new Error("Codex in-app browser did not load the local page");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    await post({ type: "close-browser-tab", conversationId, browserTabId });
    throw error;
  }
  let closed = false;
  return {
    async show() {
      if (closed) return;
      const current = await execute<string | null>(
        "window.__codexhostRendererBindingProbeV1?.currentThreadId?.() ?? null",
      );
      if (current !== conversationId)
        await post({ type: "navigate-to-route", path: `/local/${conversationId}` });
      await post({
        type: "toggle-browser-panel",
        conversationId,
        browserTabId,
        open: true,
        source: "manual",
        initiator: "codexhost_local_page",
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await post({ type: "close-browser-tab", conversationId, browserTabId });
    },
  };
}
