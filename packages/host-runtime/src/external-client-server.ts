import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { errorBody, jsonBody, writeJson } from "./delegation-control-server.js";
import { readCliCredentials } from "./cli-credentials.js";
import { DelegationControlError, EXTERNAL_CLIENT_PORT_ENV } from "./delegation-types.js";
import {
  bearerToken,
  codexhostDataDirectory,
  type ExternalClientRegistry,
} from "./external-clients.js";

export const DEFAULT_EXTERNAL_CLIENT_PORT = 4398;

/** The authenticated caller of one external request. */
export interface ExternalClientCall {
  client: string;
  request: IncomingMessage;
  response: ServerResponse;
}

/** Answers routes the listener does not serve itself; JSON POST routes resolve to a body. */
export type ExternalClientRouter = (
  call: ExternalClientCall,
  route: string,
  body: Record<string, unknown>,
) => Promise<unknown>;

/** Serves a long-lived response (for example an event stream) and owns the response. */
export type ExternalClientStreamHandler = (call: ExternalClientCall, url: URL) => Promise<void>;

export interface ExternalClientDescriptor {
  schemaVersion: 1;
  endpoint: string;
  pid: number;
  startedAt: string;
}

export interface ExternalClientServer {
  endpoint: string;
  close(): Promise<void>;
}

/** The configured port, or undefined when the listener is turned off. */
export function externalClientPort(environment: NodeJS.ProcessEnv): number | undefined {
  const value = environment[EXTERNAL_CLIENT_PORT_ENV]?.trim();
  if (!value) return DEFAULT_EXTERNAL_CLIENT_PORT;
  if (value === "off") return undefined;
  const port = /^[0-9]+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${EXTERNAL_CLIENT_PORT_ENV} must be a port number or "off"`);
  return port;
}

export function externalClientDescriptorPath(environment: NodeJS.ProcessEnv): string {
  return path.join(codexhostDataDirectory(environment), "external-client-endpoint.json");
}

export async function readExternalClientDescriptor(
  filePath: string,
): Promise<ExternalClientDescriptor | undefined> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as Partial<ExternalClientDescriptor>;
    if (value.schemaVersion !== 1 || typeof value.endpoint !== "string") return undefined;
    return value as ExternalClientDescriptor;
  } catch {
    return undefined;
  }
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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function unauthorized(response: ServerResponse): void {
  // The same answer for a missing, unknown, or revoked token, so it reveals no client names.
  writeJson(response, 401, {
    error: { code: "UNAUTHORIZED", message: "Client token is missing or invalid" },
  });
}

/**
 * Loopback listener for registered external clients on a fixed port. Requests
 * authenticate with a client token; the Host's internal token is never accepted
 * here. Returns undefined when the port is taken, so Desktop keeps working
 * without the listener.
 */
export async function startExternalClientServer(input: {
  port: number;
  clients: ExternalClientRegistry;
  route: ExternalClientRouter;
  streams?: Record<string, ExternalClientStreamHandler>;
  descriptorPath: string;
  cliCredentials?: { path: string; token: string };
  diagnose?: (message: string) => void;
}): Promise<ExternalClientServer | undefined> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const client = await input.clients.authenticate(bearerToken(request.headers.authorization));
      if (!client) {
        unauthorized(response);
        return;
      }
      const call = { client, request, response };
      const stream = input.streams?.[url.pathname];
      if (stream) {
        await stream(call, url);
        return;
      }
      if (request.method !== "POST") {
        writeJson(response, 405, {
          error: { code: "INVALID_ARGUMENT", message: "POST is required" },
        });
        return;
      }
      const body = await jsonBody(request);
      writeJson(response, 200, await input.route(call, url.pathname, body));
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      writeJson(response, error instanceof DelegationControlError ? 400 : 500, errorBody(error));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(input.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    input.diagnose?.(
      `external client listener is off: port ${input.port} is in use; set ${EXTERNAL_CLIENT_PORT_ENV} to another port or "off"`,
    );
    return undefined;
  }
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const descriptor: ExternalClientDescriptor = {
    schemaVersion: 1,
    endpoint,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const removePublishedFiles = async () => {
    // A newer Runtime may have published its own connection information.
    const current = await readExternalClientDescriptor(input.descriptorPath);
    if (
      current?.pid === descriptor.pid &&
      current.startedAt === descriptor.startedAt &&
      current.endpoint === descriptor.endpoint
    )
      await rm(input.descriptorPath, { force: true });
    if (input.cliCredentials) {
      const credentials = await readCliCredentials(input.cliCredentials.path).catch(
        () => undefined,
      );
      if (credentials?.token === input.cliCredentials.token)
        await rm(input.cliCredentials.path, { force: true });
    }
  };
  try {
    await writePrivateJson(input.descriptorPath, descriptor);
    if (input.cliCredentials)
      await writePrivateJson(input.cliCredentials.path, {
        ...descriptor,
        token: input.cliCredentials.token,
      });
  } catch (error) {
    await closeServer(server);
    await removePublishedFiles();
    throw error;
  }
  return {
    endpoint,
    close: async () => {
      try {
        await closeServer(server);
      } finally {
        await removePublishedFiles();
      }
    },
  };
}
