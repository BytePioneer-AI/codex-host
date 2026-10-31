/**
 * Sidebar browser host: one persistent Chrome profile on the CodexHost machine whose tabs are
 * streamed to Web viewers. Logins persist in the profile like an ordinary browser on that machine.
 *
 * Tabs are keyed by the viewer's sidebar tab, survive viewer disconnects for a grace period so a
 * reload or a phone switching networks reattaches, and the browser exits when no tab remains.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { chromium, type BrowserContext, type Page } from "playwright-core";
import { WebSocketServer, type WebSocket } from "ws";
import {
  SIDEBAR_BROWSER_TAB_PARAM,
  isSidebarBrowserTabKey,
} from "@codexhost/shared-contracts/sidebar-browser";

import {
  DEFAULT_SIDEBAR_BROWSER_QUALITY,
  SidebarBrowserTab,
  type SidebarBrowserQuality,
} from "./sidebar-browser-tab.ts";

const MAX_TABS = 12;
/** A tab without viewers keeps its page this long, so reloads and network switches reattach. */
const DETACHED_TAB_MS = 5 * 60_000;
/** The browser process exits once no tab has existed for this long. */
const IDLE_BROWSER_MS = 60_000;
const SWEEP_MS = 15_000;
const POPUP_URL_TIMEOUT_MS = 5_000;

export interface SidebarBrowserOptions {
  /** Persistent profile directory owned by the Web server. */
  readonly profileDirectory: string;
  readonly quality?: Partial<SidebarBrowserQuality>;
}

export class SidebarBrowser {
  private readonly tabs = new Map<string, SidebarBrowserTab>();
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  private readonly alive = new WeakSet<WebSocket>();
  private readonly quality: SidebarBrowserQuality;
  private context: Promise<BrowserContext> | undefined;
  private idleSince = Date.now();
  private readonly sweeper: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly options: SidebarBrowserOptions) {
    this.quality = { ...DEFAULT_SIDEBAR_BROWSER_QUALITY, ...options.quality };
    this.sweeper = setInterval(() => {
      void this.sweep();
    }, SWEEP_MS);
    this.sweeper.unref();
  }

  /** Accept an already authenticated, same-origin upgrade. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const key = new URL(request.url ?? "/", "http://local").searchParams.get(
      SIDEBAR_BROWSER_TAB_PARAM,
    );
    if (!isSidebarBrowserTabKey(key) || this.closed) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    this.sockets.handleUpgrade(request, socket, head, (ws) => {
      this.alive.add(ws);
      ws.on("pong", () => this.alive.add(ws));
      const tab = this.tab(key);
      if (tab === undefined)
        ws.close(
          1013,
          `At most ${String(MAX_TABS)} browser tabs can be open; close one and retry.`,
        );
      else tab.attach(ws);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    await Promise.all([...this.tabs.values()].map((tab) => tab.close()));
    this.tabs.clear();
    await this.stopBrowser();
  }

  private tab(key: string): SidebarBrowserTab | undefined {
    let tab = this.tabs.get(key);
    if (tab !== undefined) return tab;
    if (this.tabs.size >= MAX_TABS) {
      const oldest = [...this.tabs.values()]
        .filter((candidate) => candidate.detachedAt !== undefined)
        .sort((a, b) => (a.detachedAt ?? 0) - (b.detachedAt ?? 0))[0];
      if (oldest !== undefined) {
        this.tabs.delete(oldest.key);
        void oldest.close();
      }
    }
    if (this.tabs.size >= MAX_TABS) return undefined;
    tab = new SidebarBrowserTab(key, () => this.browser(), this.quality);
    this.tabs.set(key, tab);
    return tab;
  }

  private browser(): Promise<BrowserContext> {
    if (this.closed) return Promise.reject(new Error("The Web server is stopping."));
    const pending = (this.context ??= launch(
      this.options.profileDirectory,
      this.quality.deviceScale,
    ).then((context) => {
      context.on("page", (page) => {
        void this.popup(page);
      });
      context.on("close", () => {
        if (this.context === pending) this.context = undefined;
      });
      return context;
    }));
    pending.catch(() => {
      if (this.context === pending) this.context = undefined;
    });
    return pending;
  }

  /** Windows a page opens become viewer tabs; the opener's page keeps its own history. */
  private async popup(page: Page): Promise<void> {
    const opener = await page.opener();
    if (opener === null) return;
    const tab = [...this.tabs.values()].find((candidate) => candidate.owns(opener));
    if (page.url() === "about:blank")
      await page
        .waitForURL((url) => url.href !== "about:blank", {
          waitUntil: "commit",
          timeout: POPUP_URL_TIMEOUT_MS,
        })
        .catch(() => undefined);
    const url = page.url();
    await page.close().catch(() => undefined);
    if (tab !== undefined && /^https?:/u.test(url)) tab.openRequested(url);
  }

  private async sweep(): Promise<void> {
    for (const socket of this.sockets.clients) {
      if (!this.alive.has(socket)) {
        socket.terminate();
        continue;
      }
      this.alive.delete(socket);
      socket.ping();
    }
    const now = Date.now();
    for (const tab of this.tabs.values()) {
      if (tab.detachedAt === undefined) continue;
      if (!tab.hasPage || now - tab.detachedAt > DETACHED_TAB_MS) {
        this.tabs.delete(tab.key);
        await tab.close();
      }
    }
    if (this.tabs.size > 0 || this.context === undefined) this.idleSince = now;
    else if (now - this.idleSince > IDLE_BROWSER_MS) await this.stopBrowser();
  }

  private async stopBrowser(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    await (await context?.catch(() => undefined))?.close().catch(() => undefined);
  }
}

/**
 * Launch headless Chrome with a persistent profile: `CODEXHOST_BROWSER_EXECUTABLE`, else the
 * installed Chrome or Edge, else a Playwright-managed Chromium. Nothing is downloaded on demand.
 */
async function launch(profileDirectory: string, deviceScale: number): Promise<BrowserContext> {
  const executable = process.env.CODEXHOST_BROWSER_EXECUTABLE;
  const candidates: Array<{ channel?: string; executablePath?: string }> =
    executable === undefined || executable === ""
      ? [{ channel: "chrome" }, { channel: "msedge" }, {}]
      : [{ executablePath: executable }];
  let failure: unknown;
  for (const candidate of candidates) {
    try {
      const context = await chromium.launchPersistentContext(profileDirectory, {
        ...candidate,
        headless: true,
        viewport: null,
        acceptDownloads: false,
        args: [`--force-device-scale-factor=${String(deviceScale)}`],
      });
      // The profile opens with a blank page that no viewer owns.
      await Promise.all(context.pages().map((page) => page.close()));
      return context;
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(
    `No usable browser on the CodexHost machine: install Chrome or Edge, or set CODEXHOST_BROWSER_EXECUTABLE. (${
      failure instanceof Error ? (failure.message.split("\n")[0] ?? "") : String(failure)
    })`,
  );
}
