import { randomUUID } from "node:crypto";
import { RTCPeerConnection, SessionDescription, type RTCDataChannel } from "werift";
import type { WebSocket } from "ws";
import {
  SIDEBAR_BROWSER_DIRECT_CANCEL_REASONS,
  SIDEBAR_BROWSER_DIRECT_CLIENT_FAILURE_REASONS,
  SIDEBAR_BROWSER_DIRECT_CONTROL,
  SIDEBAR_BROWSER_DIRECT_HEARTBEAT_MS,
  SIDEBAR_BROWSER_DIRECT_IDLE_MS,
  SIDEBAR_BROWSER_DIRECT_PING,
  SIDEBAR_BROWSER_DIRECT_TIMEOUT_MS,
  SIDEBAR_BROWSER_STUN_URLS,
  isSidebarBrowserStunUrl,
  isSidebarBrowserTabKey,
  parseSidebarBrowserDirectClientMessage,
  sidebarBrowserFramesChannel,
  type SidebarBrowserDirectClientMessage,
  type SidebarBrowserDirectServerMessage,
} from "@codexhost/shared-contracts/sidebar-browser";
import type { CredentialConnections } from "./auth.ts";
import { SidebarBrowserIceSummary } from "./sidebar-browser-ice-summary.ts";
import type { DataDir } from "./store.ts";

export function sidebarDirectStunUrls(override: string | undefined): readonly string[] {
  if (override === undefined) return SIDEBAR_BROWSER_STUN_URLS;
  if (override === "") return [];
  const urls = override.split(",").map((url) => url.trim());
  if (!urls.every(isSidebarBrowserStunUrl))
    throw new Error("CODEXHOST_WEB_STUN_URLS only accepts stun: addresses");
  return urls;
}

type Offer = Extract<SidebarBrowserDirectClientMessage, { type: "direct-offer" }>;
type Candidate = Extract<SidebarBrowserDirectClientMessage, { type: "direct-candidate" }>;
type Unsubscribe = () => void;
type Attempt = {
  readonly offer: Offer;
  readonly peer: Peer;
  readonly started: number;
  readonly deadline: ReturnType<typeof setTimeout>;
  readonly cleanup: Unsubscribe[];
  readonly frames: Map<string, RTCDataChannel>;
  readonly falls: Set<(reason: string) => void>;
  readonly iceSummary: SidebarBrowserIceSummary;
  candidates: Promise<unknown>;
  ready: boolean;
  answered: boolean;
};
type Peer = {
  pc: RTCPeerConnection;
  control?: RTCDataChannel;
  fingerprint: string;
  remoteUfrag: string;
};

export class SidebarBrowserDirect {
  private readonly sessions = new Map<string, SidebarDirectSession>();
  private readonly target: string;
  private readonly boot = randomUUID();

  constructor(
    data: DataDir,
    private readonly connections: CredentialConnections,
    private readonly iceServers: readonly string[],
  ) {
    const file = "sidebar-direct-target.json";
    this.target = data.readJson(file, "") || randomUUID();
    data.writeJson(file, this.target, { mode: 0o600 });
  }

  attach(socket: WebSocket, credential: string, offered: boolean): void {
    const peer = randomUUID();
    const session = new SidebarDirectSession(socket, this.iceServers, () =>
      this.sessions.delete(peer),
    );
    this.sessions.set(peer, session);
    this.connections.track(credential, {
      destroy: () => session.close("revoked"),
      once: socket.once.bind(socket),
    });
    session.start(credential, {
      type: "direct-hello",
      peer,
      target: this.target,
      boot: this.boot,
      iceServers: this.iceServers,
      offered: offered && this.iceServers.length > 0,
    });
  }

  session(peer: string, credential: string | undefined): SidebarDirectSession | undefined {
    const session = this.sessions.get(peer);
    return session?.credential === credential ? session : undefined;
  }

  close(): void {
    for (const session of this.sessions.values()) session.close("shutdown");
  }
}

export class SidebarDirectSession {
  credential: string | undefined;
  private readonly started = performance.now();
  private closed = false;
  private offered = false;
  private lastOffer = 0;
  private peer: Peer | undefined;
  private peerExpiry: ReturnType<typeof setTimeout> | undefined;
  private current: Attempt | undefined;
  private readonly fallbacks = new Map<string, number>();
  private readonly frameBytes = { directBytes: 0, socketBytes: 0 };

  constructor(
    private readonly socket: WebSocket,
    private readonly iceServers: readonly string[],
    private readonly detach: () => void,
  ) {}

  start(
    credential: string,
    hello: Extract<SidebarBrowserDirectServerMessage, { type: "direct-hello" }>,
  ): void {
    this.credential = credential;
    this.offered = hello.offered;
    this.socket.on("close", () => this.close("signaling-closed"));
    this.socket.on("error", () => this.close("signaling-error"));
    this.socket.on("message", (data, binary) => {
      if (binary || this.closed || !this.offered) return;
      let message: SidebarBrowserDirectClientMessage | undefined;
      try {
        message = parseSidebarBrowserDirectClientMessage(JSON.parse(String(data)));
      } catch {
        return;
      }
      if (message !== undefined) this.receive(message);
    });
    this.send(hello);
  }

  bind(
    tab: string,
    onFallback: (reason: string) => void,
  ):
    | {
        channel: RTCDataChannel;
        attempt: number;
        release: Unsubscribe;
        fail: (reason: string) => void;
      }
    | undefined {
    const current = this.current;
    const channel = current?.frames.get(sidebarBrowserFramesChannel(tab));
    if (!current?.ready || channel?.readyState !== "open") return undefined;
    current.frames.delete(channel.label); // A channel belongs to only one label viewer.
    current.falls.add(onFallback);
    return {
      channel,
      attempt: current.offer.attempt,
      release: () => {
        current.falls.delete(onFallback);
      },
      fail: (reason) => this.fail(current, reason),
    };
  }

  countFrameBytes(via: "direct" | "socket", bytes: number): void {
    if (!this.closed) this.frameBytes[via === "direct" ? "directBytes" : "socketBytes"] += bytes;
  }

  fallback(reason: string): void {
    this.fallbacks.set(reason, (this.fallbacks.get(reason) ?? 0) + 1);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.end(reason);
    this.closePeer();
    if (this.offered)
      console.info(
        "[direct] session",
        JSON.stringify({
          durationMs: Math.round(performance.now() - this.started),
          ...this.frameBytes,
          fallbacks: Object.fromEntries(this.fallbacks),
        }),
      );
    this.socket.terminate();
  }

  private receive(message: SidebarBrowserDirectClientMessage): void {
    if (message.type === "direct-skipped") {
      console.info(
        "[direct] attempt",
        JSON.stringify({
          outcome: "skipped",
          reason: message.reason === "cooldown" ? "cooldown" : "unsupported",
          restart: false,
        }),
      );
      return;
    }
    if (message.type === "direct-offer") {
      if (message.attempt <= this.lastOffer) return;
      this.lastOffer = message.attempt;
      clearTimeout(this.peerExpiry);
      this.end("replaced");
      if (!message.restart) this.closePeer();
      try {
        this.negotiate(message);
      } catch {
        this.closePeer();
        this.report(message, "failed", "offer-error", {
          candidates: new SidebarBrowserIceSummary().summary(),
        });
        this.send({ type: "direct-close", attempt: message.attempt, reason: "offer-error" });
      }
      return;
    }
    const current = this.current;
    if (current?.offer.attempt !== message.attempt) return;
    if (message.type === "direct-close") {
      const cancelled = SIDEBAR_BROWSER_DIRECT_CANCEL_REASONS.includes(message.reason);
      const known =
        cancelled || SIDEBAR_BROWSER_DIRECT_CLIENT_FAILURE_REASONS.includes(message.reason);
      this.end(
        known ? message.reason : "unclassified",
        current.ready || cancelled ? "closed" : "failed",
      );
      this.closePeer();
    } else this.addCandidate(current, message.candidate);
  }

  private negotiate(offer: Offer): void {
    // A DataChannel-only offer needs one live application m-line, not media tracks.
    const [media, ...other] = SessionDescription.parse(offer.sdp).media;
    if (
      media?.kind !== "application" ||
      media.port === 0 ||
      other.length !== 0 ||
      !media.iceParams?.usernameFragment ||
      !media.dtlsParams?.fingerprints.length
    )
      throw new Error("Expected a DataChannel offer");
    const fingerprint = media.dtlsParams.fingerprints
      .map(({ algorithm, value }) => `${algorithm}:${value.toLowerCase()}`)
      .sort()
      .join(" ");
    const remoteUfrag = media.iceParams.usernameFragment;
    let peer: Peer;
    if (offer.restart) {
      const existing = this.peer;
      if (
        !existing ||
        existing.pc.signalingState !== "stable" ||
        existing.fingerprint !== fingerprint ||
        existing.remoteUfrag === remoteUfrag
      )
        throw new Error("Expected an ICE restart on the same DTLS association");
      existing.remoteUfrag = remoteUfrag;
      peer = existing;
    } else {
      const pc = new RTCPeerConnection({
        iceStunGatherTimeout: 1.5,
        iceServers: this.iceServers.map((urls) => ({ urls })),
      });
      peer = this.peer = { fingerprint, remoteUfrag, pc };
      pc.onDataChannel.subscribe((channel) => this.channel(peer, channel));
    }
    const { pc } = peer;
    const iceSummary = new SidebarBrowserIceSummary();
    for (const candidate of media.iceCandidates) iceSummary.received(candidate);
    const current: Attempt = {
      offer,
      peer,
      started: performance.now(),
      deadline: setTimeout(
        () => this.fail(current, "ready-timeout"),
        SIDEBAR_BROWSER_DIRECT_TIMEOUT_MS,
      ),
      ready: false,
      answered: false,
      cleanup: [],
      frames: new Map(),
      falls: new Set(),
      iceSummary,
      candidates: Promise.resolve(),
    };
    this.current = current;
    const active = () => this.current === current;
    current.cleanup.push(() => clearTimeout(current.deadline));
    const changed = (state: string): void => {
      if (!active()) return;
      if (state === "closed" || (current.ready && (state === "disconnected" || state === "failed")))
        this.fail(current, "connection-lost");
      else this.maybeReady(current);
    };
    current.cleanup.push(
      pc.connectionStateChange.subscribe(changed).unSubscribe,
      pc.iceConnectionStateChange.subscribe(changed).unSubscribe,
      pc.onIceCandidate.subscribe((candidate) => {
        if (!active() || !current.answered) return;
        const info = candidate?.toJSON();
        const ufrag = info?.usernameFragment;
        if (
          ufrag != null &&
          ufrag !==
            pc.sctpTransport?.dtlsTransport.iceTransport.getLocalParameters().usernameFragment
        )
          return;
        this.send({
          type: "direct-candidate",
          attempt: offer.attempt,
          candidate: info
            ? {
                candidate: info.candidate,
                sdpMid: info.sdpMid ?? null,
                sdpMLineIndex: info.sdpMLineIndex ?? null,
                usernameFragment: ufrag ?? null,
              }
            : null,
        });
      }).unSubscribe,
    );
    if (
      peer.control &&
      (peer.control.readyState === "open" || peer.control.readyState === "connecting")
    )
      this.watchControl(current, peer.control);
    current.candidates = pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    void current.candidates
      .then(async () => {
        if (!active()) return;
        const answer = await pc.createAnswer();
        if (!active()) return;
        const applied = pc.signalingStateChange.subscribe((state) => {
          if (state !== "stable" || !active()) return;
          applied.unSubscribe();
          current.answered = true;
          // werift publishes the applied SDP before its STUN gathering promise settles.
          this.send({ type: "direct-answer", attempt: offer.attempt, sdp: answer.sdp });
        });
        current.cleanup.push(applied.unSubscribe);
        await pc.setLocalDescription(answer);
        this.maybeReady(current);
      })
      .catch(() => this.fail(current, "negotiation-error"));
  }

  private addCandidate(current: Attempt, candidate: Candidate["candidate"]): void {
    if (!candidate) return; // End of candidates is informational.
    if (
      candidate.usernameFragment == null ||
      candidate.usernameFragment === current.peer.remoteUfrag
    )
      current.iceSummary.receivedLine(candidate.candidate);
    current.candidates = current.candidates
      .then(async () => {
        if (this.current === current) await current.peer.pc.addIceCandidate(candidate);
      })
      .catch(() => this.fail(current, "candidate-error"));
  }

  private channel(peer: Peer, channel: RTCDataChannel): void {
    if (
      this.peer !== peer ||
      !channel.ordered ||
      channel.maxPacketLifeTime != null ||
      channel.maxRetransmits != null
    ) {
      channel.close();
      return;
    }
    const current = this.current;
    if (
      channel.label === SIDEBAR_BROWSER_DIRECT_CONTROL &&
      peer.control?.readyState !== "open" &&
      peer.control?.readyState !== "connecting"
    ) {
      // The replacement control can arrive on the existing SCTP association before the restart offer.
      peer.control = channel;
      if (current) this.watchControl(current, channel);
    } else if (
      current?.ready &&
      isSidebarBrowserTabKey(channel.label.startsWith("frames:") ? channel.label.slice(7) : null)
    ) {
      current.frames.get(channel.label)?.close();
      current.frames.set(channel.label, channel);
      current.cleanup.push(
        channel.stateChanged.subscribe((state) => {
          if (state === "closed" && current.frames.get(channel.label) === channel)
            current.frames.delete(channel.label);
        }).unSubscribe,
      );
    } else channel.close();
  }

  private watchControl(current: Attempt, channel: RTCDataChannel): void {
    current.cleanup.push(
      channel.stateChanged.subscribe((state) => {
        if (current.peer.control !== channel) return;
        if (state === "open") this.maybeReady(current);
        if (state === "closed") this.fail(current, "control-closed");
      }).unSubscribe,
      channel.error.subscribe(() => {
        if (current.peer.control === channel) this.fail(current, "control-error");
      }).unSubscribe,
    );
  }

  private maybeReady(current: Attempt): void {
    if (this.current !== current || current.ready || !current.answered) return;
    const { pc, control } = current.peer;
    const transport = pc.sctpTransport?.dtlsTransport;
    const ice = transport?.iceTransport;
    const pair = ice?.getSelectedCandidatePair();
    if (
      control?.readyState !== "open" ||
      transport?.state !== "connected" ||
      !ice ||
      !pair ||
      !["connected", "completed"].includes(ice.state)
    )
      return;
    if (pair.local.type === "relay" || pair.remote.type === "relay") {
      this.fail(current, "relay-candidate");
      return;
    }
    current.ready = true;
    clearTimeout(current.deadline);
    let idle: ReturnType<typeof setTimeout>;
    const renew = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => this.fail(current, "heartbeat-timeout"),
        SIDEBAR_BROWSER_DIRECT_IDLE_MS,
      );
    };
    renew();
    const heartbeat = setInterval(() => {
      if (this.current !== current) return;
      try {
        control.send(SIDEBAR_BROWSER_DIRECT_PING);
      } catch {
        this.fail(current, "control-send");
      }
    }, SIDEBAR_BROWSER_DIRECT_HEARTBEAT_MS);
    current.cleanup.push(control.onMessage.subscribe(renew).unSubscribe, () => {
      clearInterval(heartbeat);
      clearTimeout(idle);
    });
    this.report(current.offer, "ready", "connected", {
      readyMs: Math.round(performance.now() - current.started),
      pair: `${pair.local.type}/${pair.remote.type}`,
    });
    this.send({ type: "direct-ready", attempt: current.offer.attempt });
  }

  private fail(current: Attempt, reason: string): void {
    if (this.current !== current) return;
    this.end(reason, current.ready ? "closed" : "failed");
    if (!current.ready || current.peer.pc.signalingState === "closed") this.closePeer();
    else this.peerExpiry = setTimeout(() => this.closePeer(), SIDEBAR_BROWSER_DIRECT_TIMEOUT_MS);
    this.send({ type: "direct-close", attempt: current.offer.attempt, reason });
  }

  private end(reason: string, outcome: "closed" | "failed" = "closed"): void {
    const current = this.current;
    if (!current) return;
    this.current = undefined;
    for (const cleanup of current.cleanup) cleanup();
    for (const fall of current.falls) fall(reason);
    for (const channel of current.frames.values()) channel.close();
    // Before the answer is applied, a reused peer still holds the preceding ICE generation.
    const ice = current.answered
      ? current.peer.pc.sctpTransport?.dtlsTransport.iceTransport
      : undefined;
    this.report(current.offer, outcome, reason, { candidates: current.iceSummary.summary(ice) });
  }

  private closePeer(): void {
    clearTimeout(this.peerExpiry);
    const peer = this.peer;
    this.peer = undefined;
    if (peer) void peer.pc.close().catch(() => undefined);
  }

  private report(
    offer: Offer,
    outcome: "ready" | "closed" | "failed",
    reason: string,
    details:
      | { readyMs: number; pair: string }
      | { candidates: ReturnType<SidebarBrowserIceSummary["summary"]> },
  ): void {
    console.info(
      "[direct] attempt",
      JSON.stringify({
        attempt: offer.attempt,
        outcome,
        reason,
        restart: offer.restart,
        ...details,
      }),
    );
  }

  private send(message: SidebarBrowserDirectServerMessage): void {
    if (!this.closed && this.socket.readyState === this.socket.OPEN)
      this.socket.send(JSON.stringify(message));
  }
}
