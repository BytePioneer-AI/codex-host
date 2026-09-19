// Experimental ZCode 3.12.3 terminal-side Relay protocol. No reconnect or credential storage.
import { createHmac, randomUUID } from "node:crypto";

const MAX_FRAME_BYTES = 1024 * 1024;
export class ProbeError extends Error {
  constructor(code) {
    super(code); // Fixed codes only: never forward native errors, URLs, proofs or pairing secrets.
    this.name = "ZcodePairingProbeError";
    this.code = code;
  }
}

export function parsePairingUrl(input) {
  try {
    if (typeof input !== "string" || Buffer.byteLength(input) > 8192) throw new Error();
    const url = new URL(input.trim());
    if (
      url.origin !== "https://zcode.z.ai" ||
      !/^\/remote\/v4\/?$/u.test(url.pathname) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error();
    for (const key of ["sid", "hash", "app_version"]) {
      if (url.searchParams.getAll(key).length !== 1) throw new Error();
    }
    const deviceSid = url.searchParams.get("sid");
    const passHash = url.searchParams.get("hash");
    const deviceMid = url.searchParams.get("mid");
    if (
      url.searchParams.getAll("mid").length > 1 ||
      (deviceMid !== null && !/^[A-Za-z0-9._~-]{1,256}$/u.test(deviceMid))
    )
      throw new Error();
    if (
      !/^[A-Za-z0-9._~-]{1,256}$/u.test(deviceSid ?? "") ||
      !/^[A-Za-z0-9+/]{43}=$/u.test(passHash ?? "")
    )
      throw new Error();
    if (url.searchParams.get("app_version") !== "3.12.3")
      throw new ProbeError("unsupported-desktop-version");
    // Relay destination is fixed, never taken from URL parameters or a credential-bearing redirect.
    return { deviceSid, passHash, ...(deviceMid ? { deviceMid } : {}) };
  } catch (error) {
    throw error instanceof ProbeError ? error : new ProbeError("invalid-pairing-url");
  }
}

export function bounded(promise, timeoutMs, code, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => finish(reject, new ProbeError("connection-closed"));
    const finish = (settle, value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, new ProbeError(code)), timeoutMs);
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export class PairedRelay {
  #pairing;
  #socket;
  #state = "new";
  #proofSent = false;
  #ready = Promise.withResolvers();
  #pending = new Map();
  #listeners = new Set();
  #abort = new AbortController();
  #heartbeat;
  #lastAck = 0;
  #incoming = Promise.resolve();
  constructor(pairing, { socketFactory = (url) => new WebSocket(url), timeoutMs = 15_000 } = {}) {
    this.#pairing = pairing;
    this.socketFactory = socketFactory;
    this.timeoutMs = timeoutMs;
    this.#ready.promise.catch(() => {});
  }
  get signal() {
    return this.#abort.signal;
  }
  async connect() {
    if (this.#state !== "new") throw new ProbeError("connection-already-started");
    this.#state = "connecting";
    try {
      const endpoint = new URL("wss://zcode.z.ai/ws");
      if (this.#pairing.deviceMid) endpoint.searchParams.set("mid", this.#pairing.deviceMid);
      this.#socket = this.socketFactory(endpoint.toString());
      this.#socket.addEventListener("open", () => {
        if (this.signal.aborted) return;
        this.#state = "authenticating";
        try {
          this.#send({
            type: "auth_init",
            role: "terminal",
            device_sid: this.#pairing.deviceSid,
            meta: { platform: "web", version: "3.12.3", name: "codexhost-feasibility-probe" },
            client_ts: Date.now(),
          });
        } catch {
          this.#fail("relay-unavailable");
        }
      });
      this.#socket.addEventListener("message", (event) => {
        this.#incoming = this.#incoming
          .then(() => this.#receive(event.data))
          .catch(() => this.#fail("invalid-relay-message"));
      });
      this.#socket.addEventListener("error", () => this.#fail("relay-unavailable"));
      this.#socket.addEventListener("close", () => this.#fail("relay-disconnected"));
      await bounded(this.#ready.promise, this.timeoutMs, "pairing-timeout");
    } catch (error) {
      this.close();
      throw error instanceof ProbeError ? error : new ProbeError("relay-unavailable");
    }
  }
  #send(message) {
    if (this.#socket?.readyState !== 1 || this.signal.aborted)
      throw new ProbeError("connection-closed");
    const wire = JSON.stringify(message);
    if (Buffer.byteLength(wire) > MAX_FRAME_BYTES) throw new ProbeError("relay-frame-too-large");
    this.#socket.send(wire);
  }
  sendPayload(payload) {
    if (this.#state !== "paired") throw new ProbeError("connection-not-paired");
    this.#send({ type: "data", payload, client_ts: Date.now() });
  }
  onPayload(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async request(type, responseType, parameters = {}) {
    const requestId = `probe-${randomUUID()}`;
    const pending = Promise.withResolvers();
    this.#pending.set(requestId, { ...pending, responseType });
    try {
      this.sendPayload({ ...parameters, zcode_type: type, requestId });
      return await bounded(pending.promise, this.timeoutMs, "relay-request-timeout", this.signal);
    } finally {
      this.#pending.delete(requestId);
    }
  }
  async #receive(data) {
    if (this.signal.aborted) return;
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      if (data.size > MAX_FRAME_BYTES) throw new Error();
      data = await data.text();
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      if (data.byteLength > MAX_FRAME_BYTES) throw new Error();
      data = Buffer.from(
        data instanceof ArrayBuffer ? data : data.buffer,
        data.byteOffset ?? 0,
        data.byteLength,
      ).toString("utf8");
    }
    if (typeof data !== "string" || Buffer.byteLength(data) > MAX_FRAME_BYTES) throw new Error();
    const message = JSON.parse(data);
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
    if (message.type === "error") {
      const codes = {
        AUTH_FAILED: "pairing-rejected",
        WRONG_PARAM: "pairing-rejected",
        KICKED: "session-conflict",
        DEVICE_OFFLINE: "desktop-offline",
      };
      this.#fail(Object.hasOwn(codes, message.code) ? codes[message.code] : "relay-unavailable");
    } else if (message.type === "auth_challenge") {
      if (
        this.#state !== "authenticating" ||
        this.#proofSent ||
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
      this.#lastAck = Date.now();
      if (message.pair_status === "waiting") {
        // One-shot probe: never reconnect or take over an existing terminal automatically.
        this.#fail("desktop-not-paired");
      } else if (message.pair_status === "matched") {
        this.#state = "paired";
        this.#ready.resolve();
        this.#heartbeat ??= setInterval(() => {
          if (Date.now() - this.#lastAck > 30_000) return this.#fail("relay-heartbeat-timeout");
          try {
            this.#send({
              type: "pair_status_query",
              device_sid: this.#pairing.deviceSid,
              client_ts: Date.now(),
            });
          } catch {
            this.#fail("relay-unavailable");
          }
        }, 10_000);
      } else throw new Error();
    } else if (message.type === "data") {
      if (this.#state !== "paired") throw new Error();
      const payload = message.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
      const pending = this.#pending.get(payload.requestId);
      if (pending) {
        if (payload.zcode_type === "workspace-bridge-error" || payload.success === false)
          pending.reject(new ProbeError("desktop-request-rejected"));
        else if (payload.zcode_type === pending.responseType) pending.resolve(payload);
        else pending.reject(new ProbeError("unexpected-desktop-response"));
      } else for (const listener of this.#listeners) listener(payload);
    }
  }
  #fail(code) {
    if (this.signal.aborted) return;
    const error = new ProbeError(code);
    this.#ready.reject(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#abort.abort();
    clearInterval(this.#heartbeat);
    this.#state = "closed";
    this.#listeners.clear();
    this.#pending.clear();
    try {
      this.#socket?.close();
    } catch {
      /* No reconnect. */
    }
    this.#pairing = undefined;
  }
  close() {
    this.#fail("connection-closed");
  }
}
