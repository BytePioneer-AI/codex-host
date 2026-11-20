/**
 * One sidebar browser tab: a page in the CodexHost machine's browser, streamed to its viewers.
 *
 * Frames come from CDP screencast, which emits only when the page repaints. Every viewer has at
 * most two frames in flight and keeps only the newest pending one, so a slow link drops stale
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

import {
  SIDEBAR_INTERACTION_IDLE_MS,
  SidebarBrowserDelivery,
  sidebarBrowserReduced,
} from "./sidebar-browser-delivery.ts";
import { EDITABLE_CHANGE_BINDING, SidebarBrowserEditables } from "./sidebar-browser-input.ts";

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

const MAX_IN_FLIGHT_FRAMES = 2;
/** Enough for two typical 2x PNGs; a larger PNG may use the window alone. */
const MAX_IN_FLIGHT_BYTES = 512 * 1024;
const NAVIGATION_TIMEOUT_MS = 30_000;
const TITLE_POLL_MS = 1000;

interface Viewer {
  readonly socket: WebSocket;
  readonly heldKeys: Set<string>;
  readonly heldButtons: Set<"left" | "middle" | "right">;
  visible: boolean;
  readonly inFlight: { sequence: number; bytes: number }[];
  delivery: SidebarBrowserDelivery;
  pending: { sequence: number; frame: Buffer } | undefined;
}

interface Viewport {
  readonly width: number;
  readonly height: number;
}

interface Cast {
  readonly viewport: Viewport;
  readonly reduced: boolean;
  readonly scale: number;
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
  private casting: Cast | undefined;
  private castUpdates = Promise.resolve();
  private freshPicture = false;
  private reduced = false;
  private fullFrameBytes: number | undefined;
  private lastInput = -Infinity;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
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
  private sequence = 0;
  private readonly editables: SidebarBrowserEditables;
  private input: Promise<unknown> = Promise.resolve();
  private pendingMove: { x: number; y: number } | undefined;
  private closed = false;
  /** When the last viewer left; the page is kept for reconnects until the owner sweeps it. */
  detachedAt: number | undefined = Date.now();

  constructor(
    readonly key: string,
    private readonly context: () => Promise<BrowserContext>,
    private readonly quality: SidebarBrowserQuality,
  ) {
    this.editables = new SidebarBrowserEditables(
      () => {
        const { page, casting, viewport } = this;
        return !this.closed && page !== undefined && this.hasVisibleViewer()
          ? { page, ready: casting?.viewport === viewport }
          : undefined;
      },
      (message) => {
        for (const viewer of this.viewers) if (viewer.visible) this.send(viewer, message);
      },
      () => {
        const { cdp, casting, viewport } = this;
        if (cdp !== undefined && casting?.viewport === viewport) void this.snapshot(cdp, casting);
      },
      (2 * 1000) / quality.maxFps,
    );
  }

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
      inFlight: [],
      delivery: new SidebarBrowserDelivery(),
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
      this.adapt();
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
    this.editables.pause();
    clearTimeout(this.idleTimer);
    for (const viewer of this.viewers) viewer.socket.close(1001, "closed");
    this.viewers.clear();
    const page = this.page ?? (await this.opening?.catch(() => undefined));
    this.page = undefined;
    await page?.close().catch(() => undefined);
  }

  private receive(viewer: Viewer, message: SidebarBrowserClientMessage): void {
    switch (message.type) {
      case "ack": {
        const index = viewer.inFlight.findIndex((frame) => frame.sequence === message.sequence);
        if (index < 0) return;
        const spareSlot = hasSpareSlot(viewer, inFlightBytes(viewer));
        const acknowledged = viewer.inFlight.splice(0, index + 1);
        viewer.delivery.acknowledged(
          performance.now(),
          acknowledged.reduce((sum, frame) => sum + frame.bytes, 0),
          viewer.inFlight.length > 0,
          spareSlot,
        );
        this.adapt();
        this.flush(viewer);
        return;
      }
      case "visible":
        if (viewer.visible === message.visible) return;
        viewer.visible = message.visible;
        if (viewer.visible) this.send(viewer, this.editables.current);
        else {
          viewer.pending = undefined;
          viewer.delivery = new SidebarBrowserDelivery();
        }
        this.adapt();
        void this.updateCasting(viewer.visible);
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
    this.editables.invalidate();
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
    this.editables.invalidate();
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
        this.editables.invalidate();
        if (frame === page.mainFrame()) void this.observe();
      });
      page.on("frameattached", () => this.editables.invalidate());
      page.on("framedetached", () => this.editables.invalidate());
      page.on("load", () => {
        this.editables.refresh();
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
      // Untrusted page content can only request a refresh; it never supplies the hit areas.
      await page.exposeBinding(EDITABLE_CHANGE_BINDING, () => {
        if (this.page === page) this.editables.refresh();
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
    this.fullFrameBytes = undefined;
    this.editables.invalidate();
    await this.emulate();
    this.adapt();
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

  private adapt(now = performance.now()): void {
    const rates = [...this.viewers]
      .filter((viewer) => viewer.visible)
      .map((viewer) => {
        const bytes = inFlightBytes(viewer);
        return viewer.delivery.rate(now, bytes, hasSpareSlot(viewer, bytes));
      });
    const reduced = sidebarBrowserReduced(
      now,
      this.lastInput,
      this.reduced,
      this.fullFrameBytes,
      rates,
    );
    if (this.reduced === reduced) return;
    this.reduced = reduced;
    void this.updateCasting();
  }

  private updateCasting(freshPicture = false): Promise<void> {
    this.freshPicture ||= freshPicture;
    this.castUpdates = this.castUpdates.then(() => this.applyCasting());
    return this.castUpdates;
  }

  private async applyCasting(): Promise<void> {
    const { cdp, casting, viewport, reduced, freshPicture } = this;
    this.freshPicture = false;
    if (cdp === undefined || this.closed) return;
    if (!this.hasVisibleViewer()) {
      clearInterval(this.titlePoll);
      this.titlePoll = undefined;
      this.editables.pause();
      this.casting = undefined;
      if (casting !== undefined) await cdp.send("Page.stopScreencast").catch(() => undefined);
      return;
    }
    this.titlePoll ??= setInterval(() => {
      void this.observe();
    }, TITLE_POLL_MS);
    if (casting?.viewport === viewport && casting.reduced === reduced) {
      if (freshPicture) void this.snapshot(cdp, casting);
      return;
    }
    this.casting = undefined;
    for (const viewer of this.viewers) viewer.pending = undefined;
    if (casting !== undefined) await cdp.send("Page.stopScreencast").catch(() => undefined);
    if (this.cdp !== cdp || this.closed) return;
    const scale = Math.min(
      reduced ? 1 : this.quality.deviceScale,
      this.quality.maxPixels / Math.max(viewport.width, viewport.height),
    );
    const next = { viewport, reduced, scale };
    this.casting = next;
    if (casting === undefined) this.editables.refresh();
    else this.editables.resume();
    await cdp
      .send("Page.startScreencast", {
        format: this.quality.format,
        quality: this.quality.jpegQuality,
        maxWidth: Math.round(viewport.width * scale),
        maxHeight: Math.round(viewport.height * scale),
        everyNthFrame: 1,
      })
      .catch(() => undefined);
    // A static page may not repaint, so a (re)start always requests the current picture.
    void this.snapshot(cdp, next);
  }

  private screencastFrame(cdp: CDPSession, frame: ScreencastFrame): void {
    if (this.cdp !== cdp) return;
    const casting = this.casting;
    if (casting?.viewport === this.viewport)
      this.deliver(Buffer.from(frame.data, "base64"), casting);
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

  private async snapshot(cdp: CDPSession, casting: Cast): Promise<void> {
    const sequence = this.sequence;
    const generation = this.editables.current.generation;
    const { viewport, reduced, scale } = casting;
    try {
      const shot = await cdp.send("Page.captureScreenshot", {
        format: this.quality.format,
        ...(this.quality.format === "jpeg" ? { quality: this.quality.jpegQuality } : {}),
        ...(reduced
          ? { clip: { x: 0, y: 0, ...viewport, scale: scale / this.quality.deviceScale } }
          : {}),
      });
      if (this.casting === casting && this.viewport === viewport && this.sequence === sequence)
        this.deliver(Buffer.from(shot.data, "base64"), casting, generation);
    } catch {
      // The page is navigating or gone; the next screencast frame replaces this one.
    }
  }

  private hasVisibleViewer(): boolean {
    for (const viewer of this.viewers) if (viewer.visible) return true;
    return false;
  }

  private deliver(
    image: Buffer,
    { viewport, reduced }: Cast,
    generation = this.editables.current.generation,
  ): void {
    const sequence = ++this.sequence;
    this.editables.frame(generation);
    const frame = Buffer.concat([
      encodeSidebarBrowserFrameHeader({
        format: this.quality.format,
        ...viewport,
        sequence,
        generation,
      }),
      image,
    ]);
    if (!reduced) {
      const previous = this.fullFrameBytes ?? frame.length;
      this.fullFrameBytes = previous + (frame.length - previous) / 4;
    }
    for (const viewer of this.viewers) {
      if (!viewer.visible) continue;
      viewer.pending = { sequence, frame };
      this.flush(viewer);
    }
  }

  private flush(viewer: Viewer): void {
    const pending = viewer.pending;
    const bytesInFlight = inFlightBytes(viewer);
    if (
      pending === undefined ||
      this.casting?.viewport !== this.viewport ||
      this.casting.reduced !== this.reduced ||
      viewer.socket.readyState !== viewer.socket.OPEN ||
      viewer.inFlight.length >= MAX_IN_FLIGHT_FRAMES ||
      (bytesInFlight > 0 && bytesInFlight + pending.frame.length > MAX_IN_FLIGHT_BYTES) ||
      viewer.socket.bufferedAmount > MAX_IN_FLIGHT_BYTES
    )
      return;
    viewer.pending = undefined;
    viewer.inFlight.push({ sequence: pending.sequence, bytes: pending.frame.length });
    viewer.delivery.sent(performance.now());
    viewer.socket.send(pending.frame, { binary: true }, (error) => {
      if (!error) this.flush(viewer);
    });
  }

  private dispatchInput(
    viewer: Viewer,
    message: Extract<SidebarBrowserClientMessage, { type: "mouse" | "wheel" | "key" | "text" }>,
  ): void {
    const page = this.page;
    if (page === undefined) return;
    if (
      viewer.visible &&
      (message.type !== "mouse" || message.action !== "move" || viewer.heldButtons.size > 0)
    ) {
      this.lastInput = performance.now();
      this.adapt(this.lastInput);
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.adapt(), SIDEBAR_INTERACTION_IDLE_MS + 1);
    }
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
      viewer.socket.send(JSON.stringify(message), (error) => {
        if (!error) this.flush(viewer);
      });
  }
}

function inFlightBytes(viewer: Viewer): number {
  return viewer.inFlight.reduce((sum, frame) => sum + frame.bytes, 0);
}

function hasSpareSlot(viewer: Viewer, bytes: number): boolean {
  return (
    viewer.inFlight.length === 1 && viewer.pending === undefined && 2 * bytes <= MAX_IN_FLIGHT_BYTES
  );
}

/** First line of a browser error, e.g. `net::ERR_CONNECTION_REFUSED at http://…`. */
function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const network = /net::ERR_[A-Z_]+/u.exec(text);
  return network?.[0] ?? text.split("\n")[0] ?? text;
}
