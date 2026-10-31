/** Resolve the address an iframe loads; Web-server loopback pages go through its forwarding listener. */
import {
  BROWSER_FORWARD_METHOD,
  isLoopbackBrowserHost,
  parseBrowserForwardResult,
} from "@codexhost/shared-contracts/browser-forwarding";
import { randomUUID } from "@deepseek-ai/dsh-util-crypto";
import type { BrowserTarget } from "./url.ts";

/** A forwarding refusal or failure the Browser tab shows instead of loading. */
export class BrowserForwardError extends Error {}

/**
 * @param target - validated address the user requested.
 * @returns the address to load in this viewer's browser.
 */
export async function frameAddress(target: BrowserTarget): Promise<string> {
  const url = new URL(target.url);
  if (!isLoopbackBrowserHost(url.hostname)) return target.url;
  // Listeners serve plain HTTP; an HTTPS application page cannot frame them.
  if (window.location.protocol !== "http:") throw new BrowserForwardError("https");
  const response = await fetch(`api/${BROWSER_FORWARD_METHOD}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: randomUUID(),
      method: BROWSER_FORWARD_METHOD,
      payload: { args: { url: target.url } },
    }),
  });
  if (!response.ok) throw new BrowserForwardError(`HTTP ${String(response.status)}`);
  const envelope = (await response.json()) as {
    result: { ok: true; value: unknown } | { ok: false; error: { message: string } };
  };
  if (!envelope.result.ok) throw new BrowserForwardError(envelope.result.error.message);
  const { port } = parseBrowserForwardResult(envelope.result.value);
  return `http://${window.location.hostname}:${String(port)}${url.pathname}${url.search}${url.hash}`;
}
