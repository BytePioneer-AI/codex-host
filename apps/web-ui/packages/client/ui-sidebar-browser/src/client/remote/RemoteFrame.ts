/** Navigation of a tab that lives in the browser on the CodexHost machine, over one WebSocket. */
import { createSnapshotStore, type SnapshotStore } from "@deepseek-ai/dsh-client-store";
import {
  SIDEBAR_BROWSER_PATH,
  SIDEBAR_BROWSER_TAB_PARAM,
  type SidebarBrowserClientMessage,
  type SidebarBrowserServerMessage,
  type SidebarBrowserState,
} from "@codexhost/shared-contracts/sidebar-browser";
import {
  emptyBrowserFrame,
  type BrowserFrame,
  type BrowserFrameState,
} from "../browser/BrowserFrame.ts";
import type { BrowserPageOptions } from "../browser/BrowserPage.ts";
import { browserAddressCheckpoint, currentBrowserTarget } from "../browser/BrowserPersistence.ts";
import { parseBrowserAddress, type BrowserTarget } from "../browser/url.ts";
import type { RemotePresentation } from "./RemotePresentation.ts";

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
    const url = new URL(SIDEBAR_BROWSER_PATH.slice(1), document.baseURI);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set(SIDEBAR_BROWSER_TAB_PARAM, this.key);
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.retryMs = 500;
      for (const message of this.presentation.current) this.send(message);
      const queued = this.queued;
      this.queued = undefined;
      if (queued !== undefined) this.send(queued);
    });
    socket.addEventListener("message", (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === "string") {
        this.receive(JSON.parse(event.data) as SidebarBrowserServerMessage);
        return;
      }
      const frame = event.data;
      // Frames arrive one at a time; the ack releases the next one.
      this.drawing = this.drawing
        .then(() => this.presentation.draw(frame))
        .catch(() => undefined)
        .then(() => {
          if (this.socket === socket) this.send({ type: "ack" });
        });
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket || this.disposed) return;
      this.socket = undefined;
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

  private receive(message: SidebarBrowserServerMessage): void {
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
