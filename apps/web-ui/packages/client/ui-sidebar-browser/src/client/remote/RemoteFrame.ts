/** Navigation of a tab that lives in the browser on the CodexHost machine, over one WebSocket. */
import { createSnapshotStore, type SnapshotStore } from "@deepseek-ai/dsh-client-store";
import {
  SIDEBAR_BROWSER_TAB_PARAM,
  decodeSidebarBrowserFrameHeader,
  parseSidebarBrowserTransport,
  type SidebarBrowserClientMessage,
  type SidebarBrowserFrameHeader,
  type SidebarBrowserServerMessage,
  type SidebarBrowserState,
  type SidebarBrowserTransport,
} from "@codexhost/shared-contracts/sidebar-browser";
import {
  emptyBrowserFrame,
  type BrowserFrame,
  type BrowserFrameState,
} from "../browser/BrowserFrame.ts";
import type { BrowserPageOptions } from "../browser/BrowserPage.ts";
import { browserAddressCheckpoint, currentBrowserTarget } from "../browser/BrowserPersistence.ts";
import { parseBrowserAddress, type BrowserTarget } from "../browser/url.ts";
import { DirectFrames } from "./DirectFrames.ts";
import type { DirectSession } from "./DirectSession.ts";
import type { RemotePresentation } from "./RemotePresentation.ts";
import { sidebarBrowserSocketUrl } from "./socket-url.ts";

const MAX_RETRY_MS = 8000;

/** Owns the connection; the server owns the page, its history and its lifetime between connects. */
export class RemoteFrame implements BrowserFrame {
  private readonly store: SnapshotStore<BrowserFrameState>;
  private socket: WebSocket | undefined;
  private retryMs = 500;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Navigation requested while disconnected, sent once the connection opens. */
  private queued: SidebarBrowserClientMessage | undefined;
  private checkpoint: BrowserTarget | undefined;
  private revision = 0;
  private drawing: Promise<void> = Promise.resolve();
  private presented = 0;
  private direct: DirectFrames | undefined;
  private lastBinding = 0;
  private unsubscribeDirect: (() => void) | undefined;
  private disposed = false;

  /**
   * @param options - saved address, persistence and window-opening callback.
   * @param key - server-side tab identity, stable across reloads of this viewer.
   * @param presentation - canvas and input capture.
   */
  constructor(
    private readonly options: BrowserPageOptions,
    private readonly key: string,
    private readonly presentation: RemotePresentation,
    private readonly directSession: DirectSession,
  ) {
    this.checkpoint = currentBrowserTarget(options.initial);
    this.store = createSnapshotStore(emptyBrowserFrame());
    this.connect();
  }

  getSnapshot = (): BrowserFrameState => this.store.getSnapshot();
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  /** @param message - viewer input or state; dropped while disconnected. */
  send(message: SidebarBrowserClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  loadUrl(target: BrowserTarget): void {
    this.store.set({
      ...this.store.getSnapshot(),
      target,
      address: "requested",
      loading: true,
      error: undefined,
    });
    this.persist(target);
    this.command({ type: "navigate", url: target.url });
  }

  goBack(): void {
    this.command({ type: "back" });
  }

  goForward(): void {
    this.command({ type: "forward" });
  }

  reload(): void {
    const target = this.store.getSnapshot().target;
    if (target === undefined) return;
    if (this.store.getSnapshot().address === "requested") this.loadUrl(target);
    else this.command({ type: "reload" });
  }

  /** The server keeps the page briefly so a reopened viewer of this tab reattaches. */
  dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    this.detachDirect();
    this.socket?.close(1000);
    this.socket = undefined;
    this.presentation.dispose();
    return Promise.resolve();
  }

  private command(message: SidebarBrowserClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.send(message);
    else this.queued = message;
  }

  private connect(): void {
    if (this.disposed) return;
    const url = sidebarBrowserSocketUrl();
    url.searchParams.set(SIDEBAR_BROWSER_TAB_PARAM, this.key);
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.presented = 0;
    this.lastBinding = 0;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.retryMs = 500;
      for (const message of this.presentation.current) this.send(message);
      const queued = this.queued;
      this.queued = undefined;
      if (queued !== undefined) this.send(queued);
      this.subscribeDirect(socket);
    });
    socket.addEventListener("message", (event: MessageEvent<ArrayBuffer | string>) => {
      if (this.socket !== socket) return;
      if (typeof event.data === "string") {
        this.receive(JSON.parse(event.data) as SidebarBrowserServerMessage);
        return;
      }
      this.draw(socket, event.data);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket || this.disposed) return;
      this.socket = undefined;
      this.detachDirect();
      this.presentation.setEditables(undefined);
      const current = this.store.getSnapshot();
      if (current.target !== undefined)
        this.store.set({
          ...current,
          loading: false,
          error: {
            code: undefined,
            description: event.code === 1013 ? event.reason : undefined,
            disconnected: event.code !== 1013,
          },
        });
      this.retryTimer = setTimeout(() => {
        this.connect();
      }, this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    });
  }

  private subscribeDirect(socket: WebSocket): void {
    this.unsubscribeDirect = this.directSession.subscribe((ready) => {
      if (this.socket !== socket) return;
      const released = this.clearDirect();
      if (released !== undefined) this.send({ type: "transport", binding: released });
      if (!ready) return;
      try {
        const frames = new DirectFrames(
          ready,
          this.key,
          () => {
            if (this.direct !== frames) return;
            const binding = ++this.lastBinding;
            frames.binding = binding;
            this.send({ type: "transport", peer: ready.peer, binding });
          },
          ({ data, header }) => this.draw(socket, data, frames, header),
        );
        this.direct = frames;
      } catch {
        ready.failed("frames-open");
      }
    });
  }

  private clearDirect(): number | undefined {
    const frames = this.direct;
    this.direct = undefined;
    frames?.dispose();
    return frames?.binding;
  }

  private detachDirect(): void {
    this.unsubscribeDirect?.();
    this.unsubscribeDirect = undefined;
    this.clearDirect();
  }

  private transport(message: SidebarBrowserTransport): void {
    const frames = this.direct;
    if (frames?.binding !== message.binding) return;
    if (message.via === "direct") frames.confirm(message.from);
    else {
      this.clearDirect(); // The server already switched this tab back.
      if (frames.bound) frames.ready.failed("frames-fallback");
    }
  }

  private draw(
    socket: WebSocket,
    data: ArrayBuffer,
    direct?: DirectFrames,
    frameHeader?: SidebarBrowserFrameHeader,
  ): void {
    const current = (): boolean => this.socket === socket && (!direct || this.direct === direct);
    // Serialize presentation on both routes and acknowledge old frames without repainting them.
    this.drawing = this.drawing
      .then(async () => {
        if (!current()) return;
        const header = frameHeader ?? decodeSidebarBrowserFrameHeader(data);
        if (header.sequence > this.presented) {
          await this.presentation.draw(data, header, current);
          if (!current()) return;
          this.presented = header.sequence;
        }
        if (direct) direct.acknowledge(header.sequence);
        else this.send({ type: "ack", sequence: header.sequence });
      })
      .catch(() => {
        if (!current()) return;
        if (direct) direct.ready.failed("frame-decode");
        else socket.close();
      });
  }

  private receive(message: SidebarBrowserServerMessage): void {
    if (message.type === "transport") {
      const transport = parseSidebarBrowserTransport(message);
      if (transport) this.transport(transport);
      return;
    }
    if (message.type === "editable") {
      this.presentation.setEditables(message);
      return;
    }
    if (message.type === "open") {
      this.options.openRequested(message.url);
      return;
    }
    this.apply(message);
  }

  private apply(state: SidebarBrowserState): void {
    const current = this.store.getSnapshot();
    const parsed = state.url === undefined ? undefined : parseBrowserAddress(state.url);
    const target = parsed?.ok
      ? { ...parsed.target, title: state.title || parsed.target.title }
      : current.target;
    this.store.set({
      target,
      address: parsed?.ok ? "observed" : current.address,
      loading: state.loading,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      error: state.error === undefined ? undefined : { code: undefined, description: state.error },
      sandboxEnabled: undefined,
    });
    if (parsed?.ok && target !== undefined) this.persist(target);
  }

  private persist(target: BrowserTarget): void {
    if (target.url === this.checkpoint?.url && target.title === this.checkpoint.title) return;
    this.checkpoint = target;
    this.options.persist(browserAddressCheckpoint(target, ++this.revision));
  }
}
