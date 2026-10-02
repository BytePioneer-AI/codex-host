import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Writable } from "node:stream";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import type { RemoteAppServerSession, RemoteAppServerSessionStreams } from "./remote-app-server.js";

export const EXTERNAL_UI_DESCRIPTOR_FILE = "runtime.json";
export const EXTERNAL_UI_PROTOCOL_VERSION = 1;

export interface ExternalUiDescriptorV1 {
  schemaVersion: 1;
  protocolVersion: 1;
  pid: number;
  host: "127.0.0.1";
  port: number;
  token: string;
  startedAt: number;
}

export interface ExternalUiServer {
  descriptorPath: string;
  descriptor: ExternalUiDescriptorV1;
  close(): Promise<void>;
}

export function externalUiDescriptorPath(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(dataDirectory, EXTERNAL_UI_DESCRIPTOR_FILE);
}

function equalToken(candidate: string | null | undefined, token: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("token");
  } catch {
    return null;
  }
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new Error("Unsupported WebSocket frame payload");
}

function pipeSessionOutput(socket: WebSocket, output: PassThrough): void {
  let pending = Buffer.alloc(0);
  output.on("data", (chunk: Buffer | string) => {
    pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (true) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      const frame = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (socket.readyState === socket.OPEN) socket.send(frame, { binary: false });
    }
  });
  output.once("end", () => {
    if (pending.length > 0 && socket.readyState === socket.OPEN) {
      socket.close(1011, "Host Runtime emitted an incomplete frame");
    } else if (socket.readyState === socket.OPEN) {
      socket.close(1000);
    }
  });
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function startExternalUiServer(options: {
  environment: NodeJS.ProcessEnv;
  diagnosticOutput: Writable;
  createSession(streams: RemoteAppServerSessionStreams): RemoteAppServerSession;
  pid?: number;
  now?: () => number;
}): Promise<ExternalUiServer> {
  const token = randomBytes(32).toString("hex");
  const server = createServer((_request, response) => {
    response.writeHead(426, { Connection: "Upgrade", Upgrade: "websocket" });
    response.end();
  });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 * 1024 });
  const sessionRuns = new Set<Promise<void>>();
  const sessionClosers = new Set<() => void>();

  server.on("upgrade", (request, socket, head) => {
    if (!equalToken(requestToken(request), token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit("connection", webSocket, request);
    });
  });

  webSockets.on("connection", (socket) => {
    const sessionInput = new PassThrough();
    const sessionOutput = new PassThrough();
    const session = options.createSession({
      input: sessionInput,
      output: sessionOutput,
      diagnosticOutput: options.diagnosticOutput,
    });
    pipeSessionOutput(socket, sessionOutput);

    let inputTail = Promise.resolve();
    let sessionDisconnecting = false;
    let sessionClosing = false;
    let sessionFinished = false;

    const closeSession = (): void => {
      sessionInput.destroy();
      if (sessionClosing || sessionFinished) return;
      sessionClosing = true;
      try {
        session.close();
      } catch (error) {
        options.diagnosticOutput.write(
          `codexhost external ui close: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    };

    const disconnectSession = (): void => {
      if (sessionDisconnecting || sessionClosing || sessionFinished) return;
      sessionDisconnecting = true;
      const disconnect = (): void => {
        if (sessionClosing || sessionFinished) return;
        try {
          session.disconnect();
        } catch (error) {
          options.diagnosticOutput.write(
            `codexhost external ui disconnect: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          closeSession();
        }
      };
      void inputTail.then(disconnect, disconnect);
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Codex app-server messages must be text");
        return;
      }
      const frame = Buffer.concat([rawDataBuffer(data), Buffer.from("\n")]);
      inputTail = inputTail.then(
        () =>
          new Promise<void>((resolve, reject) => {
            sessionInput.write(frame, (error) => (error ? reject(error) : resolve()));
          }),
      );
      void inputTail.catch(() => {
        if (socket.readyState === socket.OPEN) {
          socket.close(1011, "Host Runtime input failed");
        }
      });
    });

    socket.once("close", disconnectSession);
    socket.once("error", disconnectSession);

    const running = session
      .run()
      .then((code) => {
        if (code !== 0 && socket.readyState === socket.OPEN) {
          socket.close(1011, "Host Runtime exited");
        }
      })
      .catch((error: unknown) => {
        options.diagnosticOutput.write(
          `codexhost external ui: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        if (socket.readyState === socket.OPEN) socket.close(1011, "Host Runtime failed");
      })
      .finally(() => {
        sessionFinished = true;
        sessionInput.destroy();
        sessionOutput.end();
        sessionRuns.delete(running);
        sessionClosers.delete(closeSession);
      });
    sessionRuns.add(running);
    sessionClosers.add(closeSession);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const descriptorPath = externalUiDescriptorPath(options.environment);
  const descriptor: ExternalUiDescriptorV1 = {
    schemaVersion: 1,
    protocolVersion: EXTERNAL_UI_PROTOCOL_VERSION,
    pid: options.pid ?? process.pid,
    host: "127.0.0.1",
    port: (server.address() as AddressInfo).port,
    token,
    startedAt: (options.now ?? Date.now)(),
  };
  try {
    await writePrivateJson(descriptorPath, descriptor);
  } catch (error) {
    server.close();
    throw error;
  }

  let closing: Promise<void> | null = null;
  return {
    descriptorPath,
    descriptor,
    close() {
      if (closing) return closing;
      closing = (async () => {
        await rm(descriptorPath, { force: true });
        const running = [...sessionRuns];
        for (const closeSession of sessionClosers) closeSession();
        for (const socket of webSockets.clients) socket.terminate();
        const webSocketsClosed = new Promise<void>((resolve) => {
          webSockets.close(() => resolve());
        });
        const serverClosed = new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await Promise.all([webSocketsClosed, serverClosed]);
        await Promise.allSettled(running);
      })();
      return closing;
    },
  };
}
