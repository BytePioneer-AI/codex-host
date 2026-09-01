import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

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

const inspectBody = z
  .object({ harnessId: z.string(), cwd: z.string().optional(), refresh: z.boolean().optional() })
  .strict();
const startBody = z
  .object({
    harnessId: z.string(),
    task: z.string(),
    cwd: z.string(),
    executionPolicy: z.enum(["approval-required", "unattended-full-access"]).optional(),
    parentThreadId: z.string().optional(),
    requestId: z.string().optional(),
    model: z.object({ id: z.string() }).strict().optional(),
    thinkingOptionId: z.string().optional(),
  })
  .strict();
const sendBody = z.object({ threadId: z.string(), message: z.string() }).strict();
const cancelBody = z.object({ threadId: z.string() }).strict();
const readBody = z
  .object({
    threadId: z.string(),
    view: z.enum(["result", "messages"]),
    cursor: z.string().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
const waitBody = readBody.extend({ timeoutMs: z.number().int().positive() }).strict();
const listBody = z
  .object({
    cwd: z.string().optional(),
    parentThreadId: z.string().optional(),
    limit: z.number().int().positive(),
    cursor: z.string().optional(),
    sort: z.enum([
      "created-asc",
      "created-desc",
      "updated-asc",
      "updated-desc",
      "recency-asc",
      "recency-desc",
    ]),
  })
  .strict();

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

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
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

function parseBody<T>(schema: z.ZodType<T>, body: Record<string, unknown>): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new DelegationControlError("INVALID_ARGUMENT", "Invalid request body", {
      issues: parsed.error.issues,
    });
  return parsed.data;
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
        writeJson(response, 405, {
          error: { code: "INVALID_ARGUMENT", message: "POST is required" },
        });
        return;
      }
      if (request.headers.authorization !== `Bearer ${input.token}`) {
        writeJson(response, 401, {
          error: { code: "RUNTIME_UNREACHABLE", message: "Runtime token is invalid" },
        });
        return;
      }
      const body = await jsonBody(request);
      switch (request.url) {
        case "/v1/harness/inspect":
          writeJson(
            response,
            200,
            await input.api.inspect(parseBody(inspectBody, body) as HarnessInspectInput),
          );
          return;
        case "/v1/delegate/start":
          writeJson(
            response,
            200,
            await input.api.start(parseBody(startBody, body) as DelegationStartInput),
          );
          return;
        case "/v1/thread/send":
          writeJson(response, 200, await input.api.send(parseBody(sendBody, body)));
          return;
        case "/v1/thread/cancel":
          writeJson(response, 200, await input.api.cancel(parseBody(cancelBody, body)));
          return;
        case "/v1/thread/read":
          writeJson(
            response,
            200,
            await input.api.read(parseBody(readBody, body) as ThreadReadInput),
          );
          return;
        case "/v1/thread/wait":
          writeJson(
            response,
            200,
            await input.api.wait(parseBody(waitBody, body) as ThreadWaitInput),
          );
          return;
        case "/v1/thread/list":
          writeJson(
            response,
            200,
            await input.api.list(parseBody(listBody, body) as ThreadListInput),
          );
          return;
        default:
          throw new DelegationControlError("INVALID_ARGUMENT", "Unknown Runtime control route");
      }
    })().catch((error) => {
      writeJson(response, error instanceof DelegationControlError ? 400 : 500, errorBody(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}
