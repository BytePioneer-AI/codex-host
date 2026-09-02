import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationStartInput,
  type HarnessInspectInput,
  type ThreadCancelInput,
  type ThreadListInput,
  type ThreadSendInput,
  type ThreadReadInput,
  type ThreadWaitInput,
} from "./delegation-types.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_CONNECTIONS = 32;
const CONNECTION_TIMEOUT_MS = 5_000;
const LOOPBACK_PORT_MIN = 49_152;
const LOOPBACK_PORT_COUNT = 16_384;
const LOOPBACK_LISTEN_ATTEMPTS = 8;

function listenLoopback(server: Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  let attempts = 0;
  const listen = (): void => {
    const port = LOOPBACK_PORT_MIN + Math.floor(Math.random() * LOOPBACK_PORT_COUNT);
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === "EADDRINUSE" && ++attempts < LOOPBACK_LISTEN_ATTEMPTS) {
        listen();
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve(undefined);
    });
  };
  listen();
  return promise;
}

function errorBody(error: unknown): {
  error: { code: string; message: string; details?: unknown };
} {
  if (error instanceof DelegationControlError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function writeJson(response: ServerResponse, status: number, value: unknown, close = false): void {
  if (close) response.shouldKeepAlive = false;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...(close ? { connection: "close" } : {}),
  });
  response.end(`${JSON.stringify(value)}\n`);
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES)
      throw new DelegationControlError("INVALID_ARGUMENT", "Request body is too large");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new DelegationControlError("INVALID_ARGUMENT", "Request body must be a JSON object");
  }
}

export interface DelegationControlServer {
  endpoint: string;
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

export async function startDelegationControlServer(input: {
  token: string;
  api: DelegationControlApi;
}): Promise<DelegationControlServer> {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        writeJson(
          response,
          405,
          { error: { code: "INVALID_ARGUMENT", message: "POST is required" } },
          true,
        );
        return;
      }
      if (request.headers.authorization !== `Bearer ${input.token}`) {
        writeJson(
          response,
          401,
          { error: { code: "RUNTIME_UNREACHABLE", message: "Runtime token is invalid" } },
          true,
        );
        return;
      }
      const body = await jsonBody(request);
      switch (request.url) {
        case "/v1/harness/inspect":
          writeJson(response, 200, await input.api.inspect(body as unknown as HarnessInspectInput));
          return;
        case "/v1/delegate/start":
          writeJson(response, 200, await input.api.start(body as unknown as DelegationStartInput));
          return;
        case "/v1/thread/send":
          writeJson(response, 200, await input.api.send(body as unknown as ThreadSendInput));
          return;
        case "/v1/thread/cancel":
          writeJson(response, 200, await input.api.cancel(body as unknown as ThreadCancelInput));
          return;
        case "/v1/thread/read":
          writeJson(response, 200, await input.api.read(body as unknown as ThreadReadInput));
          return;
        case "/v1/thread/wait":
          writeJson(response, 200, await input.api.wait(body as unknown as ThreadWaitInput));
          return;
        case "/v1/thread/list":
          writeJson(response, 200, await input.api.list(body as unknown as ThreadListInput));
          return;
        default:
          throw new DelegationControlError("INVALID_ARGUMENT", "Unknown Runtime control route");
      }
    })().catch((error) => {
      writeJson(response, error instanceof DelegationControlError ? 400 : 500, errorBody(error));
    });
  });
  server.headersTimeout = CONNECTION_TIMEOUT_MS;
  server.requestTimeout = CONNECTION_TIMEOUT_MS;
  let connections = 0;
  server.on("connection", (socket: Socket) => {
    if (connections >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    connections += 1;
    socket.once("close", () => {
      connections -= 1;
    });
  });
  await listenLoopback(server);
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}
