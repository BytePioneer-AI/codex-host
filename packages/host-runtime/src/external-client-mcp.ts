import { randomUUID } from "node:crypto";

import { jsonBody, writeJson } from "./delegation-control-server.js";
import { DEFAULT_WATCH_TIMEOUT_MS, DelegationControlError } from "./delegation-types.js";
import type {
  ExternalClientCall,
  ExternalClientRouter,
  ExternalClientStreamHandler,
} from "./external-client-server.js";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_TOOL_WAIT_MS = 60_000;
const DEFAULT_TOOL_WAIT_MS = 30_000;

type Arguments = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  call(args: Arguments): { route: string; body: Arguments };
}

const string = (description: string) => ({ type: "string", description });
const integer = (description: string) => ({ type: "integer", minimum: 0, description });
const thread = string("Thread id or codex://threads/<id> link");

function text(args: Arguments, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new DelegationControlError("INVALID_ARGUMENT", `${name} must be a non-empty string`);
  return value;
}

function threadId(args: Arguments): string {
  const value = text(args, "thread", true) as string;
  return value.startsWith("codex://threads/") ? value.slice("codex://threads/".length) : value;
}

function bounded(args: Arguments, name: string, fallback: number, maximum: number): number {
  const value = args[name] ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new DelegationControlError("INVALID_ARGUMENT", `${name} must be a non-negative integer`);
  return Math.min(value as number, maximum);
}

function pick(args: Arguments, names: readonly string[]): Arguments {
  return Object.fromEntries(
    names.filter((name) => args[name] !== undefined).map((name) => [name, args[name]]),
  );
}

/** Each tool is one delegation route; parameters and results match the CLI's JSON. */
const TOOLS: Tool[] = [
  {
    name: "harness_list",
    description: "List the Harnesses this codexhost can delegate to.",
    inputSchema: { type: "object", properties: {} },
    call: () => ({ route: "/v1/harness/list", body: {} }),
  },
  {
    name: "harness_inspect",
    description:
      "Read a Harness's Models, Thinking options and defaults; use the returned ids when delegating.",
    inputSchema: {
      type: "object",
      properties: {
        harnessId: string("Harness id from harness_list"),
        cwd: string("Absolute workspace path"),
        refresh: { type: "boolean" },
      },
      required: ["harnessId"],
    },
    call: (args) => ({
      route: "/v1/harness/inspect",
      body: pick(args, ["harnessId", "cwd", "refresh"]),
    }),
  },
  {
    name: "delegate_start",
    description:
      "Start a task in a new Thread and return at once. Without parentThread the work belongs to this client and cwd is required. watch=true records an event for this client when the Thread stops (read it with events_poll or the SSE stream).",
    inputSchema: {
      type: "object",
      properties: {
        harnessId: string("Harness id from harness_list"),
        task: string("The full task text"),
        taskName: string("Short display name"),
        cwd: string("Absolute workspace path"),
        model: string("Model id from harness_inspect"),
        thinking: string("Thinking option id from harness_inspect"),
        parentThread: string("Optional parent Thread"),
        requestId: string("Reuse to retry idempotently"),
        refs: {
          type: "array",
          items: { type: "string" },
          description: "Absolute URIs of where the work came from",
        },
        watch: { type: "boolean", description: "Record an event when the Thread stops" },
        watchTimeoutMs: integer("How long to watch; default 29 minutes"),
      },
      required: ["harnessId", "task"],
    },
    call: (args) => ({
      route: "/v1/delegate/start",
      body: {
        harnessId: text(args, "harnessId", true),
        task: text(args, "task", true),
        ...pick(args, ["taskName", "cwd", "requestId", "refs"]),
        ...(args.model !== undefined ? { model: { id: text(args, "model") } } : {}),
        ...(args.thinking !== undefined ? { thinkingOptionId: text(args, "thinking") } : {}),
        ...(args.parentThread !== undefined ? { parentThreadId: text(args, "parentThread") } : {}),
        ...(args.watch === true
          ? {
              watchTimeoutMs: bounded(
                args,
                "watchTimeoutMs",
                DEFAULT_WATCH_TIMEOUT_MS,
                Number.MAX_SAFE_INTEGER,
              ),
            }
          : {}),
      },
    }),
  },
  {
    name: "thread_read",
    description:
      "Read a Thread's status and latest result, or page its visible messages (view=messages). Never changes the Thread.",
    inputSchema: {
      type: "object",
      properties: {
        thread,
        view: { type: "string", enum: ["result", "messages"] },
        cursor: string("Message cursor"),
        limit: integer("Messages per page, at most 100"),
      },
      required: ["thread"],
    },
    call: (args) => ({
      route: "/v1/thread/read",
      body: {
        threadId: threadId(args),
        view: args.view ?? "result",
        ...pick(args, ["cursor", "limit"]),
      },
    }),
  },
  {
    name: "thread_wait",
    description:
      "Wait up to timeoutMs (at most 60000) for a Thread to stop, then return the same snapshot as thread_read plus timedOut.",
    inputSchema: {
      type: "object",
      properties: {
        thread,
        timeoutMs: integer("At most 60000; default 30000"),
        view: { type: "string", enum: ["result", "messages"] },
      },
      required: ["thread"],
    },
    call: (args) => ({
      route: "/v1/thread/wait",
      body: {
        threadId: threadId(args),
        view: args.view ?? "result",
        timeoutMs: bounded(args, "timeoutMs", DEFAULT_TOOL_WAIT_MS, MAX_TOOL_WAIT_MS) || 1,
      },
    }),
  },
  {
    name: "thread_list",
    description:
      "List Threads: by workspace (cwd), by parent Thread, by the client that started them, or by reference.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: string("Absolute workspace path"),
        parent: string("Parent Thread"),
        client: string("Client name"),
        ref: string("Reference URI"),
        limit: integer("At most 100; default 25"),
        cursor: string("Cursor from a previous page"),
        sort: {
          type: "string",
          enum: [
            "created-asc",
            "created-desc",
            "updated-asc",
            "updated-desc",
            "recency-asc",
            "recency-desc",
          ],
        },
      },
    },
    call: (args) => ({
      route: "/v1/thread/list",
      body: {
        ...pick(args, ["cwd", "client", "ref", "cursor"]),
        ...(args.parent !== undefined ? { parentThreadId: text(args, "parent") } : {}),
        limit: bounded(args, "limit", 25, 100) || 25,
        sort: args.sort ?? "created-desc",
      },
    }),
  },
  {
    name: "thread_send",
    description:
      "Start a new Turn in an idle Thread. THREAD_BUSY means its current Turn is still running; messages are not queued.",
    inputSchema: {
      type: "object",
      properties: { thread, message: string("Message text") },
      required: ["thread", "message"],
    },
    call: (args) => ({
      route: "/v1/thread/send",
      body: { threadId: threadId(args), message: text(args, "message", true) },
    }),
  },
  {
    name: "thread_cancel",
    description: "Cancel a Thread's active Turn, keeping the Thread and its history.",
    inputSchema: { type: "object", properties: { thread }, required: ["thread"] },
    call: (args) => ({ route: "/v1/thread/cancel", body: { threadId: threadId(args) } }),
  },
  {
    name: "thread_watch",
    description: "Record one event for this client when the Thread stops or the watch expires.",
    inputSchema: {
      type: "object",
      properties: { thread, timeoutMs: integer("Default 29 minutes") },
      required: ["thread"],
    },
    call: (args) => ({
      route: "/v1/thread/watch",
      body: {
        threadId: threadId(args),
        timeoutMs:
          bounded(args, "timeoutMs", DEFAULT_WATCH_TIMEOUT_MS, Number.MAX_SAFE_INTEGER) || 1,
      },
    }),
  },
  {
    name: "thread_watches",
    description: "List watches that have not been delivered yet.",
    inputSchema: { type: "object", properties: {} },
    call: () => ({ route: "/v1/thread/watches", body: {} }),
  },
  {
    name: "events_poll",
    description:
      "Read this client's events after a cursor (0 for all retained). Waits up to timeoutMs (at most 60000) for the first one. Pass the returned cursor back next time. CURSOR_EXPIRED: reconcile with thread_list client=<this client>.",
    inputSchema: {
      type: "object",
      properties: {
        after: integer("Cursor; 0 for all retained"),
        timeoutMs: integer("At most 60000; default 0"),
        limit: integer("At most 100"),
      },
    },
    call: (args) => ({
      route: "/v1/events/poll",
      body: pick(args, ["after", "timeoutMs", "limit"]),
    }),
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function callTool(route: ExternalClientRouter, call: ExternalClientCall, params: Arguments) {
  const tool = typeof params.name === "string" ? TOOLS_BY_NAME.get(params.name) : undefined;
  if (!tool) return undefined;
  const args = (
    typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {}
  ) as Arguments;
  try {
    const request = tool.call(args);
    const value = await route(call, request.route, request.body);
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
      isError: false,
    };
  } catch (error) {
    // Tool failures are results the model reads, carrying the same codes as the CLI.
    const body =
      error instanceof DelegationControlError
        ? {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          }
        : {
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : String(error),
          };
    return { content: [{ type: "text", text: JSON.stringify({ error: body }) }], isError: true };
  }
}

/**
 * MCP over Streamable HTTP for external clients: each POST carries one JSON-RPC
 * message and is answered with JSON. There is no server-initiated stream (GET
 * answers 405); clients that want pushed events use GET /v1/events.
 */
export function externalClientMcp(route: ExternalClientRouter): ExternalClientStreamHandler {
  return async (call) => {
    const { request, response } = call;
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = await jsonBody(request);
    } catch {
      writeJson(response, 400, rpcError(null, -32700, "Expected one JSON-RPC message"));
      return;
    }
    const { id, method } = message;
    const params = (
      typeof message.params === "object" && message.params !== null ? message.params : {}
    ) as Arguments;
    // Notifications and responses need no answer.
    if (id === undefined || method === undefined) {
      response.writeHead(202).end();
      return;
    }
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        const protocolVersion =
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0];
        response.setHeader("mcp-session-id", randomUUID());
        writeJson(
          response,
          200,
          rpcResult(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "codexhost", version: "1" },
            instructions:
              "Delegate work to agents on this machine. Start with harness_list; delegate_start without parentThread needs cwd. Results are read with thread_read; completion events come from events_poll.",
          }),
        );
        return;
      }
      case "ping":
        writeJson(response, 200, rpcResult(id, {}));
        return;
      case "tools/list":
        writeJson(
          response,
          200,
          rpcResult(id, {
            tools: TOOLS.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          }),
        );
        return;
      case "tools/call": {
        const result = await callTool(route, call, params);
        writeJson(
          response,
          200,
          result
            ? rpcResult(id, result)
            : rpcError(id, -32602, `Unknown tool: ${String(params.name)}`),
        );
        return;
      }
      default:
        writeJson(response, 200, rpcError(id, -32601, `Method not found: ${String(method)}`));
    }
  };
}
