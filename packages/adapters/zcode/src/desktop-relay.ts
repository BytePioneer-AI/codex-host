import { createHmac, randomUUID } from "node:crypto";
import { ZcodeError } from "./errors.js";
import { record } from "./protocol.js";

export interface DesktopPairing {
  deviceSid: string;
  passHash: string;
  deviceMid?: string;
}
export interface RelaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
}
const MAX_FRAME = 1024 * 1024;
export function parseDesktopPairing(value: string): DesktopPairing {
  try {
    if (value.length > 8192) throw new Error();
    const url = new URL(value.trim());
    if (
      url.origin !== "https://zcode.z.ai" ||
      url.pathname !== "/remote/v4" ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error();
    for (const key of ["sid", "hash", "app_version"])
      if (url.searchParams.getAll(key).length !== 1) throw new Error();
    if (url.searchParams.get("app_version") !== "3.12.3")
      throw new ZcodeError(
        "unsupported",
        "ZCode Desktop connection currently requires version 3.12.3",
      );
    const deviceSid = url.searchParams.get("sid") ?? "",
      passHash = url.searchParams.get("hash") ?? "",
      deviceMid = url.searchParams.get("mid");
    if (
      !/^[A-Za-z0-9._~-]{1,256}$/u.test(deviceSid) ||
      !/^[A-Za-z0-9+/]{43}=$/u.test(passHash) ||
      url.searchParams.getAll("mid").length > 1 ||
      (deviceMid !== null && !/^[A-Za-z0-9._~-]{1,256}$/u.test(deviceMid))
    )
      throw new Error();
    return { deviceSid, passHash, ...(deviceMid ? { deviceMid } : {}) };
  } catch (error) {
    if (error instanceof ZcodeError) throw error;
    throw new ZcodeError(
      "invalidRequest",
      "Copy the native ZCode Desktop 3.12.3 Web Remote Control connection URL",
    );
  }
}
export function desktopDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown, value?: T) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () =>
      finish(
        new ZcodeError(
          "unavailable",
          "ZCode Desktop connection closed; delivery or cleanup may be unconfirmed",
          true,
        ),
      );
    const timer = setTimeout(
      () =>
        finish(
          new ZcodeError(
            "unavailable",
            "ZCode Desktop request timed out; delivery or cleanup is unconfirmed",
            true,
          ),
        ),
      timeoutMs,
    );
    promise.then(
      (value) => finish(undefined, value),
      (error: unknown) => finish(error),
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
/** One authenticated connection. Never reconnect automatically or log Relay/native errors. */
export class DesktopRelay {
  #pairing: DesktopPairing | undefined;
  #socket: RelaySocket | undefined;
  #state: "new" | "authenticating" | "paired" | "closed" = "new";
  #proofSent = false;
  #ready = Promise.withResolvers<undefined>();
  #abort = new AbortController();
  #pending = new Map<
    string,
    { response: string; resolve(value: Record<string, unknown>): void; reject(error: Error): void }
  >();
  #listeners = new Set<(payload: Record<string, unknown>) => void>();
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #lastAck = 0;
  #incoming = Promise.resolve();
  constructor(
    pairing: DesktopPairing,
    readonly timeoutMs = 15_000,
    readonly socketFactory: (url: string) => RelaySocket = (url) => new WebSocket(url),
  ) {
    this.#pairing = pairing;
    void this.#ready.promise.catch(() => {});
  }
  get signal(): AbortSignal {
    return this.#abort.signal;
  }
  async connect() {
    if (this.#state !== "new" || !this.#pairing)
      throw new ZcodeError("invalidState", "ZCode Desktop connection has already started");
    try {
      const url = new URL("wss://zcode.z.ai/ws");
      if (this.#pairing.deviceMid) url.searchParams.set("mid", this.#pairing.deviceMid);
      this.#socket = this.socketFactory(url.toString());
      this.#socket.addEventListener("open", () => {
        if (this.signal.aborted) return;
        this.#state = "authenticating";
        this.#send({
          type: "auth_init",
          role: "terminal",
          device_sid: this.#pairing?.deviceSid,
          meta: { platform: "web", version: "3.12.3", name: "codexhost" },
          client_ts: Date.now(),
        });
      });
      this.#socket.addEventListener("message", (event) => {
        this.#incoming = this.#incoming
          .then(() => this.#receive("data" in event ? event.data : undefined))
          .catch(() => this.#fail("ZCode Relay returned an invalid protocol message"));
      });
      this.#socket.addEventListener("error", () => this.#fail("ZCode Relay is unavailable"));
      this.#socket.addEventListener("close", () =>
        this.#fail("ZCode Desktop disconnected; restart codexhost to reconnect explicitly"),
      );
      await desktopDeadline(this.#ready.promise, this.timeoutMs);
    } catch (error) {
      this.close();
      throw error instanceof ZcodeError
        ? error
        : new ZcodeError("unavailable", "Could not connect to ZCode Relay", true);
    }
  }
  #send(message: unknown) {
    if (this.signal.aborted || this.#socket?.readyState !== 1)
      return this.#fail("ZCode Relay is disconnected");
    try {
      const wire = JSON.stringify(message);
      if (Buffer.byteLength(wire) > MAX_FRAME) throw new Error();
      this.#socket.send(wire);
    } catch {
      this.#fail("ZCode Relay could not deliver a message");
    }
  }
  sendPayload(payload: unknown): boolean {
    if (this.#state !== "paired") return false;
    this.#send({ type: "data", payload, client_ts: Date.now() });
    return !this.signal.aborted;
  }
  onPayload(listener: (payload: Record<string, unknown>) => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  async request(type: string, response: string, parameters: Record<string, unknown> = {}) {
    const id = randomUUID(),
      pending = Promise.withResolvers<Record<string, unknown>>();
    void pending.promise.catch(() => {}); // send() may synchronously fail and reject this pending request.
    this.#pending.set(id, { ...pending, response });
    try {
      if (!this.sendPayload({ ...parameters, zcode_type: type, requestId: id }))
        throw new ZcodeError("unavailable", "ZCode Desktop is not connected");
      return await desktopDeadline(pending.promise, this.timeoutMs, this.signal);
    } finally {
      this.#pending.delete(id);
    }
  }
  async #receive(data: unknown) {
    if (this.signal.aborted) return;
    if (data instanceof Blob) {
      if (data.size > MAX_FRAME) throw new Error();
      data = await data.text();
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      if (data.byteLength > MAX_FRAME) throw new Error();
      data = Buffer.from(
        data instanceof ArrayBuffer ? data : data.buffer,
        data instanceof ArrayBuffer ? 0 : data.byteOffset,
        data.byteLength,
      ).toString("utf8");
    }
    if (typeof data !== "string" || Buffer.byteLength(data) > MAX_FRAME) throw new Error();
    const message = record(JSON.parse(data));
    if (message.type === "error") {
      this.#fail(
        message.code === "KICKED"
          ? "Another client replaced this ZCode connection; automatic reconnection is disabled"
          : "ZCode pairing was rejected or the Desktop is offline",
      );
    } else if (message.type === "auth_challenge") {
      if (
        this.#state !== "authenticating" ||
        this.#proofSent ||
        !this.#pairing ||
        typeof message.nonce !== "string" ||
        !message.nonce.length ||
        message.nonce.length > 1024
      )
        throw new Error();
      const proof = createHmac("sha256", this.#pairing.passHash)
        .update(`${message.nonce}|terminal|${this.#pairing.deviceSid}`)
        .digest("base64url");
      this.#proofSent = true;
      this.#send({
        type: "auth_response",
        device_sid: this.#pairing.deviceSid,
        proof,
        client_ts: Date.now(),
      });
    } else if (message.type === "auth_ack" || message.type === "pair_status_ack") {
      if (!this.#proofSent) throw new Error();
      if (message.pair_status !== "matched" && message.pair_status !== "waiting") throw new Error();
      if (message.pair_status === "waiting" && this.#state === "paired")
        return this.#fail("The paired ZCode Desktop is no longer available");
      this.#lastAck = Date.now();
      if (message.pair_status === "matched") {
        this.#state = "paired";
        this.#ready.resolve(undefined);
      }
      this.#heartbeat ??= setInterval(() => {
        if (Date.now() - this.#lastAck > 30_000)
          return this.#fail("ZCode Relay heartbeat timed out");
        this.#send({
          type: "pair_status_query",
          device_sid: this.#pairing?.deviceSid,
          client_ts: Date.now(),
        });
      }, 10_000);
    } else if (message.type === "data") {
      if (this.#state !== "paired") throw new Error();
      const payload = record(message.payload),
        pending = this.#pending.get(String(payload.requestId));
      if (pending) {
        if (payload.zcode_type === pending.response && payload.success !== false)
          pending.resolve(payload);
        else
          pending.reject(
            new ZcodeError("unavailable", "ZCode Desktop rejected the workspace connection"),
          );
      } else for (const listener of this.#listeners) listener(payload);
    }
  }
  #fail(message: string) {
    if (this.signal.aborted) return;
    const error = new ZcodeError("unavailable", message, true);
    this.#ready.reject(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#abort.abort();
    clearInterval(this.#heartbeat);
    this.#state = "closed";
    this.#listeners.clear();
    this.#pending.clear();
    this.#pairing = undefined;
    try {
      this.#socket?.close();
    } catch {
      /* Never take over another terminal. */
    }
  }
  close() {
    this.#fail("ZCode Desktop connection closed");
  }
}
