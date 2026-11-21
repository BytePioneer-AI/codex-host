import {
  SIDEBAR_BROWSER_DIRECT_CONTROL,
  SIDEBAR_BROWSER_DIRECT_HEARTBEAT_MS,
  SIDEBAR_BROWSER_DIRECT_IDLE_MS,
  SIDEBAR_BROWSER_DIRECT_PING,
  SIDEBAR_BROWSER_DIRECT_TIMEOUT_MS,
  parseSidebarBrowserDirectServerMessage,
  type SidebarBrowserDirectClientMessage,
  type SidebarBrowserDirectServerMessage,
} from "@codexhost/shared-contracts/sidebar-browser";
import { DirectBackoff } from "./DirectBackoff.ts";
import { prepareDirectOffer } from "./DirectOffer.ts";
import { sidebarBrowserSocketUrl } from "./socket-url.ts";

type Hello = Extract<SidebarBrowserDirectServerMessage, { type: "direct-hello" }>;
type Candidate = Extract<SidebarBrowserDirectClientMessage, { type: "direct-candidate" }>;
type Stage = "initial" | "restart" | "rebuild";

const NO_VIEWER_GRACE_MS = 30_000;

type Attempt = {
  id: number;
  pc: RTCPeerConnection;
  control: RTCDataChannel;
  lifetime: AbortController;
  hello: Hello;
  stage: Stage;
  network: string;
  sent: boolean;
  confirmed: boolean;
  deadline?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  idle?: ReturnType<typeof setTimeout>;
  incoming: Promise<void>;
};

export type DirectReady = {
  attempt: number;
  peer: string;
  pc: RTCPeerConnection;
  failed: (reason: string) => void;
};

/** One signaling connection and at most one active WebRTC negotiation per Web page. */
export class DirectSession {
  private readonly lifetime = new AbortController();
  private readonly backoff = new DirectBackoff(() => window.localStorage);
  private readonly listeners = new Set<(ready: DirectReady | undefined) => void>();
  private readonly viewers = new Set<object>();
  private noViewerTimer: ReturnType<typeof setTimeout> | undefined;
  private socket: WebSocket | undefined;
  private hello: Hello | undefined;
  private current: Attempt | undefined;
  private ready: DirectReady | undefined;
  private generation = 0;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private retryMs = 500;
  private paused = false;

  constructor() {
    const { signal } = this.lifetime;
    const connection = (navigator as Navigator & { connection?: EventTarget & { type?: string } })
      .connection;
    let networkType = connection?.type;
    connection?.addEventListener(
      "change",
      () => {
        const type = connection.type;
        if (type === networkType) return;
        networkType = type;
        if (this.current) {
          if (this.ready) this.fail(this.current, "network-changed");
          else this.cancel("network-changed");
        }
        this.resume();
      },
      { signal },
    );
    window.addEventListener("online", this.resume, { signal });
    window.addEventListener(
      "pagehide",
      () => {
        this.paused = true;
        this.closeSocket();
      },
      { signal },
    );
    window.addEventListener(
      "pageshow",
      () => {
        this.paused = false;
        this.resume();
      },
      { signal },
    );
    window.addEventListener("codexhost:sign-out", () => this.dispose(), { signal });
    document.addEventListener(
      "visibilitychange",
      () => {
        if (!this.active) this.cancel("background");
        else this.resume();
      },
      { signal },
    );
  }

  /** Keep one page-level connection until the last visible viewer has been gone for 30s. */
  setViewerVisible(viewer: object, visible: boolean): void {
    if (this.lifetime.signal.aborted) return;
    if (visible) {
      const wake = this.viewers.size === 0 && this.noViewerTimer === undefined;
      this.viewers.add(viewer);
      clearTimeout(this.noViewerTimer);
      this.noViewerTimer = undefined;
      if (wake) this.resume();
    } else if (this.viewers.delete(viewer) && this.viewers.size === 0) {
      this.noViewerTimer = setTimeout(() => {
        this.noViewerTimer = undefined;
        this.closeSocket();
      }, NO_VIEWER_GRACE_MS);
    }
  }

  subscribe(listener: (ready: DirectReady | undefined) => void): () => void {
    this.listeners.add(listener);
    listener(this.ready);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.lifetime.abort();
    clearTimeout(this.noViewerTimer);
    this.viewers.clear();
    this.closeSocket();
    this.listeners.clear();
  }

  private get active(): boolean {
    return (
      !this.lifetime.signal.aborted &&
      !this.paused &&
      document.visibilityState !== "hidden" &&
      (this.viewers.size > 0 || this.noViewerTimer !== undefined)
    );
  }

  private resume = (): void => {
    if (!this.active) return;
    if (this.socket === undefined) this.connect();
    else if (this.hello?.offered && this.current === undefined) this.start(this.hello, "initial");
  };

  private connect(): void {
    clearTimeout(this.reconnect);
    const socket = new WebSocket(sidebarBrowserSocketUrl());
    this.socket = socket;
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      let message: SidebarBrowserDirectServerMessage | undefined;
      try {
        message = parseSidebarBrowserDirectServerMessage(JSON.parse(event.data));
      } catch {
        return;
      }
      if (message !== undefined) this.receive(message);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.closeSocket();
      if (this.active) {
        this.reconnect = setTimeout(this.resume, this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 8_000);
      }
    };
  }

  private closeSocket(): void {
    clearTimeout(this.reconnect);
    const socket = this.socket;
    this.socket = undefined;
    this.hello = undefined;
    this.cancel("signaling-closed");
    socket?.close();
  }

  private receive(message: SidebarBrowserDirectServerMessage): void {
    if (message.type === "direct-hello") {
      if (this.hello !== undefined) return;
      this.backoff.setBoot(message.target, message.boot);
      if (!message.offered) {
        this.dispose();
        return;
      }
      this.hello = message;
      this.retryMs = 500;
      this.resume();
      return;
    }
    const attempt = this.current;
    if (!attempt?.sent || message.attempt !== attempt.id) return;
    if (message.type === "direct-close") {
      this.fail(attempt, message.reason, true);
      return;
    }
    attempt.incoming = attempt.incoming
      .then(async () => {
        if (this.current !== attempt) return;
        if (message.type === "direct-answer") {
          await attempt.pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
        } else if (message.type === "direct-candidate") {
          // End-of-candidates is informational; connectivity checks are already running.
          if (message.candidate !== null) await attempt.pc.addIceCandidate(message.candidate);
        } else {
          attempt.confirmed = true;
          this.publish(attempt);
        }
      })
      .catch(() => this.fail(attempt, "signaling-error"));
  }

  private send(message: SidebarBrowserDirectClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private start(hello: Hello, stage: Stage, previous?: Attempt): void {
    if (typeof RTCPeerConnection !== "function") {
      this.send({ type: "direct-skipped", reason: "unsupported" });
      return;
    }
    let pc = previous?.pc;
    let control: RTCDataChannel;
    try {
      pc ??= new RTCPeerConnection({ iceServers: hello.iceServers.map((urls) => ({ urls })) });
      control =
        previous?.control.readyState === "open"
          ? previous.control
          : pc.createDataChannel(SIDEBAR_BROWSER_DIRECT_CONTROL);
    } catch {
      pc?.close();
      if (stage === "restart") this.start(hello, "rebuild");
      else this.send({ type: "direct-skipped", reason: "unsupported" });
      return;
    }
    const attempt: Attempt = {
      id: ++this.generation,
      pc,
      control,
      hello,
      stage,
      network: previous?.network ?? "none",
      lifetime: new AbortController(),
      incoming: Promise.resolve(),
      sent: false,
      confirmed: false,
    };
    this.current = attempt;
    this.watch(attempt);
    void this.offer(attempt).catch(() => this.fail(attempt, "offer-error"));
  }

  private async offer(attempt: Attempt): Promise<void> {
    const { id, hello, pc, stage, lifetime } = attempt;
    const cached: Candidate[] = [];
    const restart = stage === "restart";
    const { network, sdp } = await prepareDirectOffer(pc, restart, lifetime.signal, (candidate) => {
      if (this.current !== attempt) return;
      const message: Candidate = {
        type: "direct-candidate",
        attempt: id,
        candidate:
          candidate === null ? null : { ...candidate.toJSON(), candidate: candidate.candidate },
      };
      if (attempt.sent) this.send(message);
      else cached.push(message);
    });
    if (this.current !== attempt) return;
    if (!this.active) {
      this.cancel("background");
      return;
    }
    attempt.network = network;
    if (this.backoff.cooling(hello.target, network, Date.now())) {
      this.send({ type: "direct-skipped", reason: "cooldown" });
      this.cancel("cooldown");
      return;
    }
    attempt.sent = true;
    this.send({ type: "direct-offer", attempt: id, sdp, restart });
    for (const message of cached) this.send(message);
    cached.length = 0;
    attempt.deadline = setTimeout(
      () => this.fail(attempt, "ready-timeout"),
      SIDEBAR_BROWSER_DIRECT_TIMEOUT_MS,
    );
  }

  private watch(attempt: Attempt): void {
    const {
      pc,
      control,
      lifetime: { signal },
    } = attempt;
    const disconnected = (): void => {
      if (this.current !== attempt) return;
      const states = [pc.connectionState, pc.iceConnectionState];
      // The old ICE state can remain failed until the restart is applied.
      if (
        states.includes("closed") ||
        ((attempt.stage !== "restart" || this.ready) &&
          (states.includes("failed") || states.includes("disconnected")))
      )
        this.fail(attempt, "connection-lost");
    };
    pc.addEventListener("connectionstatechange", disconnected, { signal });
    pc.addEventListener("iceconnectionstatechange", disconnected, { signal });
    control.addEventListener("open", () => this.publish(attempt), { signal });
    for (const event of ["close", "error"] as const)
      control.addEventListener(event, () => this.fail(attempt, `control-${event}`), { signal });
  }

  private publish(attempt: Attempt): void {
    const {
      control,
      hello,
      lifetime: { signal },
    } = attempt;
    if (
      this.current !== attempt ||
      this.ready ||
      !attempt.confirmed ||
      control.readyState !== "open"
    )
      return;
    if (!this.active) {
      this.cancel("background");
      return;
    }
    clearTimeout(attempt.deadline);
    this.backoff.succeeded(hello.target, attempt.network);
    const resetIdle = (): void => {
      clearTimeout(attempt.idle);
      attempt.idle = setTimeout(
        () => this.fail(attempt, "heartbeat-timeout"),
        SIDEBAR_BROWSER_DIRECT_IDLE_MS,
      );
    };
    control.addEventListener("message", resetIdle, { signal });
    resetIdle();
    attempt.heartbeat = setInterval(() => {
      if (this.current !== attempt) return;
      if (!this.active) this.cancel("background");
      else {
        try {
          control.send(SIDEBAR_BROWSER_DIRECT_PING);
        } catch {
          this.fail(attempt, "control-send");
        }
      }
    }, SIDEBAR_BROWSER_DIRECT_HEARTBEAT_MS);
    this.ready = {
      attempt: attempt.id,
      peer: hello.peer,
      pc: attempt.pc,
      failed: (reason) => this.fail(attempt, reason),
    };
    for (const listener of this.listeners) {
      if (this.current !== attempt) break;
      listener(this.ready);
    }
  }

  private release(): void {
    const attempt = this.current;
    this.current = undefined;
    attempt?.lifetime.abort();
    clearTimeout(attempt?.deadline);
    clearInterval(attempt?.heartbeat);
    clearTimeout(attempt?.idle);
    if (this.ready) {
      this.ready = undefined;
      for (const listener of this.listeners) listener(undefined);
    }
  }

  private cancel(reason: string): void {
    const attempt = this.current;
    if (!attempt) return;
    this.release();
    this.closeAttempt(attempt, reason);
  }

  private closeAttempt(attempt: Attempt, reason?: string): void {
    attempt.pc.close();
    if (attempt.sent && reason) this.send({ type: "direct-close", attempt: attempt.id, reason });
  }

  private fail(attempt: Attempt, reason: string, remote = false): void {
    if (this.current !== attempt) return;
    const wasReady = this.ready !== undefined;
    this.release(); // Switch viewers back before beginning either recovery step.
    if (!this.active) {
      this.closeAttempt(attempt, remote ? undefined : reason);
      return;
    }
    if (
      wasReady &&
      attempt.pc.signalingState !== "closed" &&
      attempt.pc.connectionState !== "closed" &&
      attempt.pc.iceConnectionState !== "closed"
    ) {
      // A restart offer replaces the old generation without closing the peer on either side.
      this.start(attempt.hello, "restart", attempt);
      return;
    }
    this.closeAttempt(attempt, remote ? undefined : reason);
    if (wasReady || attempt.stage === "restart") this.start(attempt.hello, "rebuild");
    else this.backoff.failed(attempt.hello.target, attempt.network, Date.now());
  }
}
