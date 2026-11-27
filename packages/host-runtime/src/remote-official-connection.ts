import type { ClientRequest, IncomingMessage } from "node:http";
import net from "node:net";
import { PassThrough, Transform, Writable } from "node:stream";

import type { JsonObject } from "@codexhost/protocol-core";

import WebSocket, { type RawData } from "ws";

import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "./official-app-server-connection.js";

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new Error("Unsupported WebSocket frame payload");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OfficialAppServerHandshakeError extends Error {
  constructor(readonly status: number | undefined) {
    super(`Official app-server rejected WebSocket upgrade (HTTP ${status ?? "unknown"})`);
  }
}

/**
 * Adapts one native app-server WebSocket client to the LF-delimited streams
 * consumed by AppServerHost. Every remote Desktop client gets its own socket,
 * while all sockets terminate at the same official listener so Codex can
 * assign native owner and observer roles.
 */
export async function createRemoteOfficialAppServerConnection(
  endpoint: string,
  options: {
    capabilityToken?: string;
    headers?: Record<string, string>;
    handshakeTimeoutMs?: number;
  } = {},
): Promise<OfficialAppServerConnection> {
  const describeError = options.capabilityToken
    ? (): string => "Private official connection failed"
    : errorMessage;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closed = Promise.withResolvers<OfficialAppServerExit>();
  let settled = false;
  let closeRequested = false;
  const inputFrames = new LfFrameBuffer();
  let outputPaused = false;

  const webSocketOptions = {
    // This private native listener can return large history pages, including
    // images. Match stdio instead of retiring the connection at an arbitrary
    // response size; ws uses zero for an unlimited payload.
    maxPayload: 0,
    // The native Codex daemon client uses tokio-tungstenite without offering
    // permessage-deflate. Keep the same handshake for every private listener.
    perMessageDeflate: false,
    handshakeTimeout: options.handshakeTimeoutMs,
    headers:
      options.capabilityToken === undefined
        ? options.headers
        : { ...options.headers, Authorization: `Bearer ${options.capabilityToken}` },
  } as const;
  let socket: WebSocket;
  if (endpoint.startsWith("ws://")) {
    const url = new URL(endpoint);
    if (
      url.protocol !== "ws:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.port
    ) {
      throw new Error("Shared official app-server URL must use a loopback WebSocket endpoint");
    }
    socket = new WebSocket(endpoint, webSocketOptions);
  } else {
    socket = new WebSocket("ws://localhost/", {
      ...webSocketOptions,
      createConnection: () => net.createConnection(endpoint),
    });
  }

  const finish = (result: OfficialAppServerExit): void => {
    if (settled) return;
    settled = true;
    stdin.destroy();
    stdout.end();
    stderr.end();
    closed.resolve(result);
  };

  const fail = (error: Error): void => {
    if (settled) return;
    stderr.write(`codexhost shared official connection: ${describeError(error)}\n`);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  };

  const sendFrame = (frame: Buffer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Official app-server WebSocket is not open"));
        return;
      }
      socket.send(frame, { binary: false }, (error) => (error ? reject(error) : resolve()));
    });

  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      void (async () => {
        for (const frame of inputFrames.push(chunk, { copyTail: true })) await sendFrame(frame);
      })().then(
        () => callback(),
        (error: unknown) => {
          const cause = new Error(describeError(error));
          fail(cause);
          callback(cause);
        },
      );
    },
    final(callback) {
      if (inputFrames.incomplete) {
        const error = new Error("Host Runtime emitted an incomplete official app-server frame");
        fail(error);
        callback(error);
        return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
      callback();
    },
  });
  stdin.on("error", (error) => {
    if (!settled) stderr.write(`codexhost shared official connection: ${describeError(error)}\n`);
  });

  const opened = Promise.withResolvers<undefined>();
  const onOpen = () => opened.resolve(undefined);
  const onResponse = (_request: ClientRequest, response: IncomingMessage): void => {
    response.resume();
    opened.reject(new OfficialAppServerHandshakeError(response.statusCode));
  };
  socket.once("open", onOpen);
  socket.once("error", opened.reject);
  socket.once("unexpected-response", onResponse);

  socket.on("message", (data, isBinary) => {
    if (closeRequested || stdout.destroyed) return;
    if (isBinary) {
      fail(new Error("Official app-server emitted a binary WebSocket frame"));
      return;
    }
    if (!stdout.write(Buffer.concat([rawDataBuffer(data), Buffer.from("\n")])) && !outputPaused) {
      outputPaused = true;
      socket.pause();
      stdout.once("drain", () => {
        outputPaused = false;
        if (socket.readyState === WebSocket.OPEN) socket.resume();
      });
    }
  });
  socket.on("error", (error) => {
    if (!settled) stderr.write(`codexhost shared official connection: ${describeError(error)}\n`);
  });
  socket.once("close", (code, reason) => {
    const normal = code === 1000 || closeRequested;
    const detail =
      !options.capabilityToken && reason.length > 0 ? `: ${reason.toString("utf8")}` : "";
    finish({
      code: normal ? 0 : 1,
      signal: null,
      ...(normal
        ? {}
        : { error: new Error(`Official app-server WebSocket closed (${code})${detail}`) }),
    });
  });

  try {
    await opened.promise;
  } catch (error) {
    socket.terminate();
    finish({
      code: null,
      signal: null,
      error: new Error(describeError(error)),
    });
    if (error instanceof OfficialAppServerHandshakeError) throw error;
    throw new Error(`Shared official app-server connection failed: ${describeError(error)}`);
  } finally {
    socket.off("open", onOpen);
    socket.off("error", opened.reject);
    socket.off("unexpected-response", onResponse);
  }

  return {
    stdin,
    stdout,
    stderr,
    closed: closed.promise,
    close() {
      if (closeRequested) return;
      closeRequested = true;
      stdin.destroy();
      // A detached reader cannot drain stdout. Resume transport so its close frame can arrive.
      if (outputPaused) socket.resume();
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    },
  };
}

/** Split LF-delimited bytes while holding only the fragments of an unfinished frame. */
class LfFrameBuffer {
  readonly #parts: Buffer[] = [];
  #length = 0;

  constructor(private readonly limit = Infinity) {}

  get incomplete(): boolean {
    return this.#length > 0;
  }

  *push(chunk: Buffer, options?: { copyTail: boolean }): Iterable<Buffer> {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const slice = chunk.subarray(offset, newline === -1 ? chunk.length : newline);
      this.#length += slice.length;
      if (newline === -1) {
        if (this.#length > this.limit) this.#parts.length = 0;
        else this.#parts.push(options?.copyTail ? Buffer.from(slice) : slice);
        return;
      }
      const frame =
        this.#length <= this.limit &&
        (this.#parts.length ? Buffer.concat([...this.#parts, slice], this.#length) : slice);
      this.#parts.length = 0;
      this.#length = 0;
      offset = newline + 1;
      if (frame) yield frame;
    }
  }
}

const FULL_PARSE_LIMIT = 1024 * 1024;
// Match the authenticated channel's inbound WebSocket limit.
const REQUEST_FRAME_LIMIT = 128 * 1024 * 1024;
const TURN_EVENTS = ["turn/started", "turn/completed", "thread/closed"];
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;

interface ResponseObservation {
  hasPending(): boolean;
  expectsTurnResult(id: string | number): boolean;
}

function whitespace(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
}

function skipWhitespace(frame: Buffer, offset: number): number {
  while (whitespace(frame[offset])) offset++;
  return offset;
}

function stringEnd(frame: Buffer, start: number): number {
  // Native searches skip long strings such as base64 image data in one pass.
  for (
    let quote = frame.indexOf(QUOTE, start + 1);
    quote !== -1;
    quote = frame.indexOf(QUOTE, quote + 1)
  ) {
    let escape = quote;
    while (frame[escape - 1] === BACKSLASH) escape--;
    if ((quote - escape) % 2 === 0) return quote + 1;
  }
  throw new SyntaxError("Unterminated JSON string");
}

function valueEnd(frame: Buffer, start: number): number {
  const first = frame[start];
  if (first === QUOTE) return stringEnd(frame, start);
  if (first !== OPEN_ARRAY && first !== OPEN_OBJECT) {
    let end = start;
    while (end < frame.length) {
      const byte = frame[end];
      if (whitespace(byte) || byte === 0x2c || byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) break;
      end++;
    }
    if (end === start) throw new SyntaxError("Missing JSON value");
    return end;
  }

  let depth = 1;
  let offset = start + 1;
  while (offset < frame.length) {
    const byte = frame[offset];
    if (byte === QUOTE) {
      offset = stringEnd(frame, offset);
      continue;
    }
    if (byte === OPEN_ARRAY || byte === OPEN_OBJECT) depth++;
    if (byte === CLOSE_ARRAY || byte === CLOSE_OBJECT) depth--;
    offset++;
    if (depth === 0) return offset;
  }
  throw new SyntaxError("Unterminated JSON container");
}

function scalar(bytes?: Buffer): string | number | undefined {
  if (!bytes || bytes[0] === OPEN_OBJECT || bytes[0] === OPEN_ARRAY) return;
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (typeof value === "string" || typeof value === "number") return value;
}

function objectFields(frame: Buffer | undefined, names: readonly string[]): Map<string, Buffer> {
  const fields = new Map<string, Buffer>();
  if (!frame) return fields;
  const start = skipWhitespace(frame, 0);
  if (frame[start] !== OPEN_OBJECT) return fields;
  // Every observed key is ASCII. Each character can occupy up to six bytes when escaped.
  const maxKeyBytes = 2 + 6 * Math.max(...names.map((name) => name.length));
  let offset = skipWhitespace(frame, start + 1);
  while (frame[offset] !== CLOSE_OBJECT) {
    if (frame[offset] !== QUOTE) throw new SyntaxError("Expected a JSON property name");
    const keyEnd = stringEnd(frame, offset);
    const key = keyEnd - offset <= maxKeyBytes ? scalar(frame.subarray(offset, keyEnd)) : undefined;
    const colon = skipWhitespace(frame, keyEnd);
    if (frame[colon] !== 0x3a) throw new SyntaxError("Expected a JSON property value");
    const valueStart = skipWhitespace(frame, colon + 1);
    const end = valueEnd(frame, valueStart);
    if (typeof key === "string" && names.includes(key))
      fields.set(key, frame.subarray(valueStart, end));
    offset = skipWhitespace(frame, end);
    if (frame[offset] === CLOSE_OBJECT) break;
    if (frame[offset] !== 0x2c) throw new SyntaxError("Expected a JSON property separator");
    offset = skipWhitespace(frame, offset + 1);
  }
  return fields;
}

function projectedFrame(frame: Buffer, response?: ResponseObservation): JsonObject {
  const fields = objectFields(frame, ["id", "method", "params", "result"]);
  const id = scalar(fields.get("id"));
  const method = scalar(fields.get("method"));
  const value: JsonObject = {};
  if (id !== undefined) value.id = id;
  if (typeof method === "string") {
    value.method = method;
    if (method === "turn/start" || TURN_EVENTS.includes(method)) {
      const params = objectFields(fields.get("params"), ["threadId", "turn"]);
      const threadId = scalar(params.get("threadId"));
      if (typeof threadId === "string") {
        const turn = objectFields(params.get("turn"), ["id"]);
        const turnId = scalar(turn.get("id"));
        value.params = {
          threadId,
          ...(typeof turnId === "string" ? { turn: { id: turnId } } : {}),
        };
      }
    }
  } else if (id !== undefined && response?.expectsTurnResult(id)) {
    const result = objectFields(fields.get("result"), ["turn"]);
    const turn = objectFields(result.get("turn"), ["status"]);
    const status = scalar(turn.get("status"));
    if (typeof status === "string") value.result = { turn: { status } };
  }
  return value;
}

/** Observe tracking fields while forwarding every byte of the original stream. */
export function observeProxyFrames(
  observe: (value: JsonObject) => void,
  response?: ResponseObservation,
): Transform {
  const frames = new LfFrameBuffer(response ? Infinity : REQUEST_FRAME_LIMIT);
  const observeLine = (line: Buffer): void => {
    try {
      const large = line.length > FULL_PARSE_LIMIT;
      const escapedEventsOnly =
        !large &&
        response &&
        !response.hasPending() &&
        !TURN_EVENTS.some((event) => line.includes(event));
      // An idle frame with an escaped method name can still carry a Turn event.
      if (escapedEventsOnly && !line.includes(BACKSLASH)) return;
      const value: unknown =
        large || escapedEventsOnly
          ? projectedFrame(line, response)
          : JSON.parse(line.toString("utf8"));
      if (value === null || typeof value !== "object" || Array.isArray(value)) return;
      const frame = value as JsonObject;
      if (
        !escapedEventsOnly ||
        (typeof frame.method === "string" && TURN_EVENTS.includes(frame.method))
      )
        observe(frame);
    } catch {
      /* Preserve raw byte pass-through if a non-JSON line appears. */
    }
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      for (const frame of frames.push(chunk)) observeLine(frame);
      callback(null, chunk);
    },
  });
}
