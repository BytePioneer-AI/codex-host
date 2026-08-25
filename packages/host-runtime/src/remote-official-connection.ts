import net from "node:net";
import { PassThrough, Writable } from "node:stream";

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

/**
 * Adapts one native app-server WebSocket client to the LF-delimited streams
 * consumed by AppServerHost. Every remote Desktop client gets its own socket,
 * while all sockets terminate at the same official listener so Codex can
 * assign native owner and observer roles.
 */
export async function createRemoteOfficialAppServerConnection(
  socketPath: string,
): Promise<OfficialAppServerConnection> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closed = Promise.withResolvers<OfficialAppServerExit>();
  let settled = false;
  let closeRequested = false;
  let pending = Buffer.alloc(0);
  let outputPaused = false;

  const socket = new WebSocket("ws://localhost/", {
    createConnection: () => net.createConnection(socketPath),
    maxPayload: 128 * 1024 * 1024,
    // The native Codex daemon client uses tokio-tungstenite without offering
    // permessage-deflate. Keep the same handshake for the control socket.
    perMessageDeflate: false,
  });

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
    stderr.write(`codexhost shared official connection: ${error.message}\n`);
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
    write(chunk: Buffer, encoding, callback) {
      void encoding;
      pending = Buffer.concat([pending, chunk]);
      const frames: Buffer[] = [];
      while (true) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) break;
        frames.push(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
      }
      void (async () => {
        for (const frame of frames) await sendFrame(frame);
      })().then(
        () => callback(),
        (error: unknown) => {
          const cause = error instanceof Error ? error : new Error(String(error));
          fail(cause);
          callback(cause);
        },
      );
    },
    final(callback) {
      if (pending.length > 0) {
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
    if (!settled) stderr.write(`codexhost shared official connection: ${error.message}\n`);
  });

  const opened = new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      socket.off("error", onInitialError);
      resolve();
    };
    const onInitialError = (error: Error): void => {
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onInitialError);
  });

  socket.on("message", (data, isBinary) => {
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
    if (!settled) stderr.write(`codexhost shared official connection: ${error.message}\n`);
  });
  socket.once("close", (code, reason) => {
    const normal = code === 1000 || closeRequested;
    const detail = reason.length > 0 ? `: ${reason.toString("utf8")}` : "";
    finish({
      code: normal ? 0 : 1,
      signal: null,
      ...(normal
        ? {}
        : { error: new Error(`Official app-server WebSocket closed (${code})${detail}`) }),
    });
  });

  try {
    await opened;
  } catch (error) {
    socket.terminate();
    finish({
      code: null,
      signal: null,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    throw new Error(`Shared official app-server connection failed: ${errorMessage(error)}`);
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
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    },
  };
}
