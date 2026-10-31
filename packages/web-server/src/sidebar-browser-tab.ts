/**
 * One sidebar browser tab: a page in the CodexHost machine's browser, streamed to its viewers.
 *
 * Frames come from CDP screencast, which emits only when the page repaints. Every viewer has at
 * most one frame in flight and keeps only the newest pending one, so a slow link drops stale
 * frames instead of queueing them ahead of state.
 */

import type { BrowserContext, CDPSession, Page } from "playwright-core";
import type { WebSocket } from "ws";
import {
  encodeSidebarBrowserFrameHeader,
  parseSidebarBrowserClientMessage,
  type SidebarBrowserClientMessage,
  type SidebarBrowserFrameFormat,
  type SidebarBrowserServerMessage,
  type SidebarBrowserState,
} from "@codexhost/shared-contracts/sidebar-browser";

/** Stream tuning; a relayed link can trade sharpness and frame rate for bandwidth. */
export interface SidebarBrowserQuality {
  /** Lossless PNG keeps text sharp and is near JPEG size for text pages; JPEG suits video. */
  readonly format: SidebarBrowserFrameFormat;
  readonly jpegQuality: number;
  readonly maxFps: number;
  /**
   * Physical pixels per CSS pixel in every frame. Screencast follows the browser's real scale and
   * ignores emulated ratios, so this is a launch setting; viewers downscale it to their own ratio.
   */
  readonly deviceScale: number;
  /** Longest physical side of a frame; larger viewports are streamed downscaled. */
  readonly maxPixels: number;
}

export const DEFAULT_SIDEBAR_BROWSER_QUALITY: SidebarBrowserQuality = {
  format: "png",
  jpegQuality: 85,
  maxFps: 30,
  deviceScale: 2,
  maxPixels: 3200,
};

/** A viewer whose socket buffer exceeds this is treated as busy; its newest frame waits. */
const MAX_BUFFERED_BYTES = 512 * 1024;
const NAVIGATION_TIMEOUT_MS = 30_000;
const TITLE_POLL_MS = 1000;

interface Viewer {
  readonly socket: WebSocket;
  readonly heldKeys: Set<string>;
  readonly heldButtons: Set<"left" | "middle" | "right">;
  visible: boolean;
  inFlight: boolean;
  pending: Buffer | undefined;
}

interface Viewport {
  readonly width: number;
  readonly height: number;
}

interface ScreencastFrame {
  readonly data: string;
  readonly sessionId: number;
}

export class SidebarBrowserTab {
  private page: Page | undefined;
  private cdp: CDPSession | undefined;
  private opening: Promise<Page> | undefined;
  private mainFrame: string | undefined;
  private readonly viewers = new Set<Viewer>();
  private viewport: Viewport = { width: 1000, height: 800 };
  /** The CSS viewport the running screencast was started for; frame headers use it. */
  private casting: Viewport | undefined;
  private state: SidebarBrowserState = {
    type: "state",
    url: undefined,
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: undefined,
  };
  private sentState = "";
  /** `document.title` changes raise no CDP event; titles are re-read while someone is watching. */
  private titlePoll: ReturnType<typeof setInterval> | undefined;
  private lastAck = 0;
  private input: Promise<unknown> = Promise.resolve();
  private pendingMove: { x: number; y: number } | undefined;
  private closed = false;
  /** When the last viewer left; the page is kept for reconnects until the owner sweeps it. */
  detachedAt: number | undefined = Date.now();

  constructor(
    readonly key: string,
    private readonly context: () => Promise<BrowserContext>,
    private readonly quality: SidebarBrowserQuality,
  ) {}

  get hasPage(): boolean {
    return this.page !== undefined || this.opening !== undefined;
  }

  owns(page: Page): boolean {
    return this.page === page;
  }

  attach(socket: WebSocket): void {
    const viewer: Viewer = {
      socket,
      heldKeys: new Set(),
      heldButtons: new Set(),
      visible: false,
      inFlight: false,
      pending: undefined,
    };
    this.viewers.add(viewer);
    this.detachedAt = undefined;
    socket.on("message", (data, binary) => {
      if (binary) return;
      let parsed: SidebarBrowserClientMessage | undefined;
      try {
        parsed = parseSidebarBrowserClientMessage(JSON.parse(String(data)));
      } catch {
        return;
      }
      if (parsed !== undefined) this.receive(viewer, parsed);
    });
    socket.on("close", () => {
      this.viewers.delete(viewer);
      this.releaseInput(viewer);
      if (this.viewers.size === 0) this.detachedAt = Date.now();
      void this.updateCasting();
    });
    this.send(viewer, this.state);
  }

  /** The page opened a window; viewers open its address as another tab. */
  openRequested(url: string): void {
    for (const viewer of this.viewers) this.send(viewer, { type: "open", url });
  }

  /** Report a failure that prevents the page from existing, such as a missing browser. */
  fail(error: string): void {
    this.publish({ ...this.state, loading: false, error });
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.titlePoll);
    for (const viewer of this.viewers) viewer.socket.close(1001, "closed");
    this.viewers.clear();
    const page = this.page ?? (await this.opening?.catch(() => undefined));
    this.page = undefined;
    await page?.close().catch(() => undefined);
  }

  private receive(viewer: Viewer, message: SidebarBrowserClientMessage): void {
    switch (message.type) {
      case "ack":
        viewer.inFlight = false;
        this.flush(viewer);
        return;
      case "visible":
        viewer.visible = message.visible;
        void this.updateCasting(true);
        return;
      case "viewport":
        void this.resize(message);
        return;
      case "navigate":
        void this.navigate(message.url);
        return;
      case "back":
      case "forward":
      case "reload":
        void this.history(message.type);
        return;
      default:
        this.dispatchInput(viewer, message);
    }
  }

  private async navigate(url: string): Promise<void> {
    if (!/^https?:\/\//iu.test(url)) {
      this.fail("Only HTTP and HTTPS addresses can be opened.");
      return;
    }
    this.publish({ ...this.state, url: this.state.url ?? url, loading: true, error: undefined });
    let page: Page;
    try {
      page = await this.open();
    } catch (error) {
      this.fail(message(error));
      return;
    }
    await page
      .goto(url, { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS })
      .catch((error: unknown) => {
        if (this.page === page)
          this.publish({ ...this.state, loading: false, error: message(error) });
      });
    await this.observe();
  }

  private async history(command: "back" | "forward" | "reload"): Promise<void> {
    const page = this.page;
    if (page === undefined) {
      if (command === "reload" && this.state.url !== undefined) await this.navigate(this.state.url);
      return;
    }
    this.publish({ ...this.state, error: undefined });
    const options = { waitUntil: "commit" as const, timeout: NAVIGATION_TIMEOUT_MS };
    await (
      command === "back"
        ? page.goBack(options)
        : command === "forward"
          ? page.goForward(options)
          : page.reload(options)
    ).catch((error: unknown) => {
      if (this.page === page)
        this.publish({ ...this.state, loading: false, error: message(error) });
    });
    await this.observe();
  }

  private open(): Promise<Page> {
    if (this.page !== undefined) return Promise.resolve(this.page);
    this.opening ??= (async () => {
      const page = await (await this.context()).newPage();
      if (this.closed) {
        await page.close();
        throw new Error("The browser tab was closed.");
      }
      const cdp = await page.context().newCDPSession(page);
      this.page = page;
      this.cdp = cdp;
      cdp.on("Page.screencastFrame", (frame: ScreencastFrame) => {
        this.screencastFrame(cdp, frame);
      });
      cdp.on("Page.frameStartedLoading", ({ frameId }: { frameId: string }) => {
        if (this.page === page && frameId === this.mainFrame)
          this.publish({ ...this.state, loading: true, error: undefined });
      });
      cdp.on("Page.frameStoppedLoading", ({ frameId }: { frameId: string }) => {
        if (this.page !== page || frameId !== this.mainFrame) return;
        this.publish({ ...this.state, loading: false });
        void this.observe();
      });
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) void this.observe();
      });
      page.on("load", () => {
        void this.observe();
      });
      page.on("close", () => {
        if (this.page !== page) return;
        this.page = undefined;
        this.cdp = undefined;
        this.casting = undefined;
        clearInterval(this.titlePoll);
        this.titlePoll = undefined;
        this.publish({ ...this.state, loading: false, error: "The page was closed." });
      });
      page.on("crash", () => {
        this.publish({ ...this.state, loading: false, error: "The page crashed; reload it." });
      });
      await cdp.send("Page.enable");
      this.mainFrame = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
      await this.emulate();
      await this.updateCasting(true);
      return page;
    })().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async observe(): Promise<void> {
    const page = this.page;
    const cdp = this.cdp;
    if (page === undefined || cdp === undefined) return;
    try {
      const url = page.url();
      const history = await cdp.send("Page.getNavigationHistory");
      const title = await page.title().catch(() => this.state.title);
      if (this.page !== page) return;
      const failed = url.startsWith("chrome-error:");
      // The blank document every new page starts with is not a place to go back to.
      const first = history.entries.findIndex((entry) => entry.url !== "about:blank");
      this.publish({
        ...this.state,
        url: failed ? this.state.url : url,
        title,
        loading: this.state.loading && !failed,
        canGoBack: first >= 0 && history.currentIndex > first,
        canGoForward: history.currentIndex < history.entries.length - 1,
      });
    } catch {
      // Navigation replaced the document while reading; the next event observes it.
    }
  }

  private async resize(viewport: Viewport): Promise<void> {
    const width = Math.round(viewport.width);
    const height = Math.round(viewport.height);
    if (width === this.viewport.width && height === this.viewport.height) return;
    this.viewport = { width, height };
    await this.emulate();
    await this.updateCasting(true);
  }

  private async emulate(): Promise<void> {
    const { width, height } = this.viewport;
    await this.cdp
      ?.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        // 0 keeps the browser's real scale, which screencast frames are rendered at.
        deviceScaleFactor: 0,
        mobile: false,
      })
      .catch(() => undefined);
  }

  /** @param restart - viewport or visibility changed, so the stream restarts with a fresh frame. */
  private async updateCasting(restart = false): Promise<void> {
    const cdp = this.cdp;
    const wanted = cdp !== undefined && [...this.viewers].some((viewer) => viewer.visible);
    const viewport = this.viewport;
    if (cdp === undefined) return;
    if (!wanted) {
      clearInterval(this.titlePoll);
      this.titlePoll = undefined;
      if (this.casting !== undefined) {
        this.casting = undefined;
        await cdp.send("Page.stopScreencast").catch(() => undefined);
      }
      return;
    }
    this.titlePoll ??= setInterval(() => {
      void this.observe();
    }, TITLE_POLL_MS);
    if (this.casting === viewport && !restart) return;
    if (this.casting !== undefined) await cdp.send("Page.stopScreencast").catch(() => undefined);
    this.casting = viewport;
    const scale = Math.min(
      this.quality.deviceScale,
      this.quality.maxPixels / Math.max(viewport.width, viewport.height),
    );
    await cdp
      .send("Page.startScreencast", {
        format: this.quality.format,
        quality: this.quality.jpegQuality,
        maxWidth: Math.round(viewport.width * scale),
        maxHeight: Math.round(viewport.height * scale),
        everyNthFrame: 1,
      })
      .catch(() => undefined);
    // A static page may not repaint, so a (re)start always sends the current picture.
    void this.snapshot(cdp, viewport);
  }

  private screencastFrame(cdp: CDPSession, frame: ScreencastFrame): void {
    const viewport = this.casting;
    if (this.cdp !== cdp || viewport === undefined) return;
    this.deliver(Buffer.from(frame.data, "base64"), viewport);
    // Chromium sends the next frame only after an ack; pacing the ack caps the frame rate.
    const delay = Math.max(0, 1000 / this.quality.maxFps - (Date.now() - this.lastAck));
    setTimeout(() => {
      this.lastAck = Date.now();
      if (this.cdp === cdp)
        void cdp
          .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
          .catch(() => undefined);
    }, delay);
  }

  private async snapshot(cdp: CDPSession, viewport: Viewport): Promise<void> {
    try {
      const shot = await cdp.send("Page.captureScreenshot", {
        format: this.quality.format,
        ...(this.quality.format === "jpeg" ? { quality: this.quality.jpegQuality } : {}),
      });
      if (this.cdp === cdp && this.casting === viewport)
        this.deliver(Buffer.from(shot.data, "base64"), viewport);
    } catch {
      // The page is navigating or gone; the next screencast frame replaces this one.
    }
  }

  /** @param viewport - CSS size the image was rendered for; the image itself is `deviceScale`x. */
  private deliver(image: Buffer, viewport: Viewport): void {
    const frame = Buffer.concat([
      encodeSidebarBrowserFrameHeader({ format: this.quality.format, ...viewport }),
      image,
    ]);
    for (const viewer of this.viewers) {
      if (!viewer.visible) continue;
      viewer.pending = frame;
      this.flush(viewer);
    }
  }

  private flush(viewer: Viewer): void {
    const frame = viewer.pending;
    if (
      frame === undefined ||
      viewer.inFlight ||
      viewer.socket.readyState !== viewer.socket.OPEN ||
      viewer.socket.bufferedAmount > MAX_BUFFERED_BYTES
    )
      return;
    viewer.pending = undefined;
    viewer.inFlight = true;
    viewer.socket.send(frame, { binary: true });
  }

  private dispatchInput(
    viewer: Viewer,
    message: Extract<SidebarBrowserClientMessage, { type: "mouse" | "wheel" | "key" | "text" }>,
  ): void {
    const page = this.page;
    if (page === undefined) return;
    if (message.type === "mouse" && message.action === "move") {
      // Moves coalesce: only the newest position waits behind earlier input.
      const queued = this.pendingMove !== undefined;
      this.pendingMove = { x: message.x, y: message.y };
      if (queued) return;
    }
    this.input = this.input
      .then(async () => {
        if (this.page !== page) return;
        switch (message.type) {
          case "mouse": {
            if (message.action === "move") {
              const move = this.pendingMove;
              this.pendingMove = undefined;
              if (move !== undefined) await page.mouse.move(move.x, move.y);
              return;
            }
            await page.mouse.move(message.x, message.y);
            const button = message.button === "none" ? "left" : message.button;
            const options = { button, clickCount: Math.max(1, message.clickCount) };
            await (message.action === "down" ? page.mouse.down(options) : page.mouse.up(options));
            if (message.action === "down") viewer.heldButtons.add(button);
            else viewer.heldButtons.delete(button);
            return;
          }
          case "wheel":
            await page.mouse.move(message.x, message.y);
            await page.mouse.wheel(message.deltaX, message.deltaY);
            return;
          case "key":
            await (message.action === "down"
              ? page.keyboard.down(message.key)
              : page.keyboard.up(message.key));
            if (message.action === "down") viewer.heldKeys.add(message.key);
            else viewer.heldKeys.delete(message.key);
            return;
          case "text":
            await page.keyboard.insertText(message.text);
        }
      })
      .catch(() => undefined);
  }

  /** Release only this viewer's held input, after all its already queued events. */
  private releaseInput(viewer: Viewer): void {
    const page = this.page;
    this.input = this.input
      .then(async () => {
        if (page === undefined || this.page !== page) return;
        const remaining = [...this.viewers];
        for (const key of viewer.heldKeys)
          if (!remaining.some((other) => other.heldKeys.has(key)))
            await page.keyboard.up(key).catch(() => undefined);
        for (const button of viewer.heldButtons)
          if (!remaining.some((other) => other.heldButtons.has(button)))
            await page.mouse.up({ button }).catch(() => undefined);
      })
      .catch(() => undefined);
  }

  private publish(state: SidebarBrowserState): void {
    this.state = state;
    const serialized = JSON.stringify(state);
    if (serialized === this.sentState) return;
    this.sentState = serialized;
    for (const viewer of this.viewers) this.send(viewer, state);
  }

  private send(viewer: Viewer, message: SidebarBrowserServerMessage): void {
    if (viewer.socket.readyState === viewer.socket.OPEN)
      viewer.socket.send(JSON.stringify(message));
  }
}

/** First line of a browser error, e.g. `net::ERR_CONNECTION_REFUSED at http://…`. */
function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const network = /net::ERR_[A-Z_]+/u.exec(text);
  return network?.[0] ?? text.split("\n")[0] ?? text;
}
