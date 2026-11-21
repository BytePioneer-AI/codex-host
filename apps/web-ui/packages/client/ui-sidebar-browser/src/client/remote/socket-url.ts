import { SIDEBAR_BROWSER_PATH } from "@codexhost/shared-contracts/sidebar-browser";

/** Both the page signaler and the tab viewers use the authenticated Web base path. */
export function sidebarBrowserSocketUrl(): URL {
  const url = new URL(SIDEBAR_BROWSER_PATH.slice(1), document.baseURI);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}
