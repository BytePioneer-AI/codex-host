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
  type SidebarBrowserServerMessage,
  type SidebarBrowserState,
} from "@codexhost/shared-contracts/sidebar-browser";

import { SidebarBrowserDelivery } from "./sidebar-browser-delivery.ts";
import {
  SidebarBrowserCast,
  type SidebarBrowserQuality,
  type SidebarBrowserViewport as Viewport,
} from "./sidebar-browser-cast.ts";
import { SidebarBrowserQualitySelection } from "./sidebar-browser-quality.ts";
import { EDITABLE_CHANGE_BINDING, SidebarBrowserEditables } from "./sidebar-browser-input.ts";
import {
  SidebarBrowserInputBatcher,
  type SidebarBrowserInput,
} from "./sidebar-browser-input-batcher.ts";
import { SidebarDirectFrames, type SidebarDirectFrame } from "./sidebar-browser-direct-frames.ts";
import type { SidebarDirectSession } from "./sidebar-browser-direct.ts";

export {
  DEFAULT_SIDEBAR_BROWSER_QUALITY,
  type SidebarBrowserQuality,
} from "./sidebar-browser-cast.ts";

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
  readonly inFlight: { sequence: number; bytes: number; via: "direct" | "socket" }[];
  readonly findDirect: (peer: string) => SidebarDirectSession | undefined;
  binding: number;
  direct?: SidebarDirectFrames;
  session?: SidebarDirectSession;
  delivery: SidebarBrowserDelivery;
  pending: SidebarDirectFrame | undefined;
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
  private casting: SidebarBrowserCast | undefined;
  private castUpdates = Promise.resolve();
  private freshPicture = false;
  private pictureQuality: SidebarBrowserQualitySelection;
  private qualityTimer: ReturnType<typeof setTimeout> | undefined;
  private qualityCheckAt: number | undefined;
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
  private sequence = 0;
  private latest: { cast: SidebarBrowserCast; picture: SidebarDirectFrame } | undefined;
  private readonly editables: SidebarBrowserEditables;
  private input: Promise<unknown> = Promise.resolve();
  private readonly inputBatcher = new SidebarBrowserInputBatcher<Viewer, Page>();
  private closed = false;
  /** When the last viewer left; the page is kept for reconnects until the owner sweeps it. */
  detachedAt: number | undefined = Date.now();

  constructor(
    readonly key: string,
    private readonly context: () => Promise<BrowserContext>,
    private readonly quality: SidebarBrowserQuality,
    private readonly countFrameBytes: (via: "direct" | "socket", bytes: number) => void = () => {},
  ) {
    this.pictureQuality = new SidebarBrowserQualitySelection(quality.format);
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

  attach(socket: WebSocket, findDirect: Viewer["findDirect"] = () => undefined): void {
    const viewer: Viewer = {
      socket,
      findDirect,
      binding: 0,
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
      viewer.direct?.dispose();
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
    this.resetPictureQuality();
    for (const viewer of this.viewers) viewer.socket.close(1001, "closed");
    this.viewers.clear();
    const page = this.page ?? (await this.opening?.catch(() => undefined));
    this.page = undefined;
    await page?.close().catch(() => undefined);
  }

  private receive(viewer: Viewer, message: SidebarBrowserClientMessage): void {
    switch (message.type) {
      case "ack":
        this.acknowledged(viewer, message.sequence);
        return;
      case "transport":
        this.changeTransport(viewer, message.binding, message.peer);
        return;
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
        this.inputBatcher.seal();
        void this.resize(message);
        return;
      case "navigate":
        this.inputBatcher.seal();
        void this.navigate(message.url);
        return;
      case "back":
      case "forward":
      case "reload":
        this.inputBatcher.seal();
        void this.history(message.type);
        return;
      default:
        this.dispatchInput(viewer, message);
    }
  }

  private acknowledged(viewer: Viewer, sequence: number): void {
    const index = viewer.inFlight.findIndex((frame) => frame.sequence === sequence);
    if (index < 0) return;
    const via = viewer.direct ? "direct" : "socket";
    const bytes = inFlightBytes(viewer, via);
    const spareSlot = bytes === inFlightBytes(viewer) && hasSpareSlot(viewer, bytes);
    const acknowledged = viewer.inFlight.splice(0, index + 1);
    const delivered = acknowledged.reduce(
      (sum, frame) => sum + (frame.via === via ? frame.bytes : 0),
      0,
    );
    if (delivered > 0)
      viewer.delivery.acknowledged(
        performance.now(),
        delivered,
        viewer.inFlight.some((frame) => frame.via === via),
        spareSlot,
      );
    viewer.direct?.acknowledged(sequence);
    this.adapt();
    this.flush(viewer);
  }

  private changeTransport(viewer: Viewer, id: number, peer: string | undefined): void {
    if (peer === undefined) {
      if (id === viewer.binding) this.fallback(viewer, id, "client-request");
      return;
    }
    if (id <= viewer.binding) return;
    viewer.binding = id;
    const session = viewer.findDirect(peer);
    const binding = session?.bind(this.key, (reason) => this.fallback(viewer, id, reason));
    if (!session || !binding) {
      this.fallback(viewer, id, "client-request");
      return;
    }
    const direct = new SidebarDirectFrames(
      binding,
      () => this.flush(viewer),
      (sequence) => this.acknowledged(viewer, sequence),
      (bytes) => this.recordFrameBytes(viewer, "direct", bytes),
    );
    if (!direct.usable) {
      direct.dispose();
      this.fallback(viewer, id, "message-size");
      return;
    }
    this.clearDirect(viewer);
    viewer.direct = direct;
    viewer.session = session;
    viewer.delivery = new SidebarBrowserDelivery();
    this.send(viewer, {
      type: "transport",
      binding: id,
      via: "direct",
      from: viewer.pending?.sequence ?? this.sequence + 1,
    });
    this.adapt();
    this.flush(viewer);
  }

  private clearDirect(viewer: Viewer): boolean {
    const direct = viewer.direct;
    if (!direct) return false;
    delete viewer.direct;
    direct.dispose();
    for (let i = viewer.inFlight.length - 1; i >= 0; i--)
      if (viewer.inFlight[i]?.via === "direct") viewer.inFlight.splice(i, 1);
    viewer.delivery = new SidebarBrowserDelivery();
    return true;
  }

  private fallback(viewer: Viewer, id: number, reason: string): void {
    if (id !== viewer.binding) return;
    if (this.clearDirect(viewer)) {
      viewer.session?.fallback(reason);
      if (reason === "revoked" || reason === "shutdown") return;
      const latest = this.latest;
      if (
        viewer.visible &&
        latest?.cast === this.casting &&
        latest &&
        !viewer.inFlight.some((frame) => frame.sequence === latest.picture.sequence)
      )
        viewer.pending = latest.picture;
    }
    this.send(viewer, { type: "transport", binding: id, via: "socket" });
    this.flush(viewer);
    this.adapt();
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
        if (frame === page.mainFrame()) {
          this.resetPictureQuality();
          void this.updateCasting();
          void this.observe();
        }
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
        this.resetPictureQuality();
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
    this.resetPictureQuality();
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
        const bytes = inFlightBytes(viewer, viewer.direct ? "direct" : "socket");
        return viewer.delivery.rate(
          now,
          bytes,
          bytes === inFlightBytes(viewer) && hasSpareSlot(viewer, bytes),
        );
      });
    const previous = this.pictureQuality.mode;
    const mode = this.pictureQuality.update(now, rates);
    const deadline = this.pictureQuality.deadline;
    if (
      deadline === undefined ||
      this.qualityCheckAt === undefined ||
      deadline < this.qualityCheckAt
    ) {
      clearTimeout(this.qualityTimer);
      this.qualityCheckAt = deadline;
      if (deadline !== undefined)
        this.qualityTimer = setTimeout(
          () => {
            this.qualityCheckAt = undefined;
            this.adapt();
          },
          Math.max(1, Math.ceil(deadline - now)),
        );
    }
    if (previous !== mode) void this.updateCasting();
  }

  private resetPictureQuality(): void {
    clearTimeout(this.qualityTimer);
    this.qualityCheckAt = undefined;
    this.pictureQuality = new SidebarBrowserQualitySelection(this.quality.format);
  }

  private updateCasting(freshPicture = false): Promise<void> {
    this.freshPicture ||= freshPicture;
    this.castUpdates = this.castUpdates.then(() => this.applyCasting());
    return this.castUpdates;
  }

  private async applyCasting(): Promise<void> {
    const { cdp, page, casting, viewport, freshPicture } = this;
    const { mode } = this.pictureQuality;
    this.freshPicture = false;
    if (cdp === undefined || this.closed) return;
    if (!this.hasVisibleViewer()) {
      clearInterval(this.titlePoll);
      this.titlePoll = undefined;
      this.editables.pause();
      this.casting = undefined;
      this.resetPictureQuality();
      await casting?.stop(cdp);
      return;
    }
    this.titlePoll ??= setInterval(() => {
      void this.observe();
    }, TITLE_POLL_MS);
    if (casting?.viewport === viewport && casting.mode === mode) {
      if (freshPicture) void this.snapshot(cdp, casting);
      return;
    }
    this.casting = undefined;
    for (const viewer of this.viewers) viewer.pending = undefined;
    await casting?.stop(cdp);
    const current = () =>
      this.cdp === cdp &&
      !this.closed &&
      this.hasVisibleViewer() &&
      this.viewport === viewport &&
      this.pictureQuality.mode === mode;
    if (!current()) return;
    // Chrome can finish a stopped encode after restart. Isolate temporary quality levels so
    // late JPEG or 1x events (and their ACKs) cannot leak into the full-resolution PNG cast.
    const castCdp =
      mode === "full"
        ? cdp
        : await page
            ?.context()
            .newCDPSession(page)
            .catch(() => undefined);
    if (!current()) {
      if (castCdp && castCdp !== cdp) await castCdp.detach().catch(() => undefined);
      return;
    }
    if (!castCdp) {
      this.resetPictureQuality();
      void this.updateCasting(true);
      return;
    }
    if (castCdp !== cdp)
      castCdp.on("Page.screencastFrame", (frame: ScreencastFrame) =>
        this.screencastFrame(castCdp, frame),
      );
    const next = new SidebarBrowserCast(castCdp, viewport, mode, this.quality);
    this.casting = next;
    if (casting === undefined) this.editables.refresh();
    else this.editables.resume();
    const started = await next.start();
    if (!current()) return;
    if (mode !== "full" && !started) {
      this.resetPictureQuality();
      void this.updateCasting(true);
      return;
    }
    // A static page may not repaint after a restart, in particular when leaving JPEG.
    if (mode !== "motion") void this.snapshot(cdp, next);
  }

  private screencastFrame(cdp: CDPSession, frame: ScreencastFrame): void {
    const cast = this.casting;
    if (cast?.cdp !== cdp) return;
    const now = performance.now();
    if (this.currentCast(cast)) {
      const image = Buffer.from(frame.data, "base64");
      const sample = cast.sample(frame.data, image.length, now, () => {
        for (const viewer of this.viewers)
          if (viewer.visible && viewer.pending !== undefined) return true;
        return false;
      });
      this.pictureQuality.picture(sample);
      if (cast.allowPicture(now)) this.deliver(image, cast);
      if (sample.changed || cast.mode === "motion") this.adapt(now);
    }
    cast.acknowledge(frame.sessionId, now, () => this.casting === cast);
  }

  private async snapshot(cdp: CDPSession, casting: SidebarBrowserCast): Promise<void> {
    const sequence = this.sequence;
    const generation = this.editables.current.generation;
    try {
      const shot = await casting.snapshot(cdp);
      if (
        this.currentCast(casting) &&
        this.sequence === sequence &&
        casting.allowPicture(performance.now())
      ) {
        const image = Buffer.from(shot.data, "base64");
        this.pictureQuality.size(image.length);
        this.deliver(image, casting, generation);
      }
    } catch {
      // The page is navigating or gone; the next screencast frame replaces this one.
    }
  }

  private currentCast(cast: SidebarBrowserCast): boolean {
    return (
      !this.closed &&
      this.casting === cast &&
      cast.viewport === this.viewport &&
      cast.mode === this.pictureQuality.mode &&
      this.hasVisibleViewer()
    );
  }

  private hasVisibleViewer(): boolean {
    for (const viewer of this.viewers) if (viewer.visible) return true;
    return false;
  }

  private deliver(
    image: Buffer,
    cast: SidebarBrowserCast,
    generation = this.editables.current.generation,
  ): void {
    const { viewport, format } = cast;
    const sequence = ++this.sequence;
    this.editables.frame(generation);
    const frame = Buffer.concat([
      encodeSidebarBrowserFrameHeader({
        format,
        ...viewport,
        sequence,
        generation,
      }),
      image,
    ]);
    const picture = { sequence, frame };
    this.latest = { cast, picture };
    for (const viewer of this.viewers) {
      if (!viewer.visible) continue;
      viewer.pending = picture;
      this.flush(viewer);
    }
  }

  private flush(viewer: Viewer): void {
    const pending = viewer.pending;
    const bytesInFlight = inFlightBytes(viewer);
    if (
      pending === undefined ||
      this.casting === undefined ||
      !this.currentCast(this.casting) ||
      viewer.socket.readyState !== viewer.socket.OPEN ||
      viewer.inFlight.length >= MAX_IN_FLIGHT_FRAMES ||
      (bytesInFlight > 0 && bytesInFlight + pending.frame.length > MAX_IN_FLIGHT_BYTES)
    )
      return;
    const { direct, socket } = viewer;
    if (direct ? !direct.canSend(pending) : socket.bufferedAmount > MAX_IN_FLIGHT_BYTES) return;
    viewer.pending = undefined;
    viewer.inFlight.push({
      sequence: pending.sequence,
      bytes: pending.frame.length,
      via: direct ? "direct" : "socket",
    });
    viewer.delivery.sent(performance.now());
    if (direct) direct.send(pending);
    else {
      this.recordFrameBytes(viewer, "socket", pending.frame.length);
      socket.send(pending.frame, { binary: true }, (error) => {
        if (!error) this.flush(viewer);
      });
    }
  }

  private recordFrameBytes(viewer: Viewer, via: "direct" | "socket", bytes: number): void {
    this.countFrameBytes(via, bytes);
    viewer.session?.countFrameBytes(via, bytes);
  }

  private dispatchInput(viewer: Viewer, message: SidebarBrowserInput): void {
    const page = this.page;
    if (page === undefined) return;
    if (
      viewer.visible &&
      (message.type !== "mouse" || message.action !== "move" || viewer.heldButtons.size > 0)
    ) {
      const now = performance.now();
      this.pictureQuality.input(now);
      this.adapt(now);
    }
    const take = this.inputBatcher.enqueue(viewer, page, message);
    if (take === undefined) return;
    this.input = this.input
      .then(async () => {
        const message = take();
        if (this.page !== page) return;
        switch (message.type) {
          case "mouse": {
            await page.mouse.move(message.x, message.y);
            if (message.action === "move") return;
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
    this.inputBatcher.seal();
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

function inFlightBytes(viewer: Viewer, via?: "socket" | "direct"): number {
  return viewer.inFlight.reduce(
    (sum, frame) => sum + (via === undefined || frame.via === via ? frame.bytes : 0),
    0,
  );
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
