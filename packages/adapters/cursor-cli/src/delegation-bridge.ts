import { execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer as AcpMcpServer } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";

const text = z.string().min(1).max(32_768);
const optional = (flag: string, value: string | number | undefined): string[] =>
  value === undefined ? [] : [flag, String(value)];

/** Session-local native MCP tools; no global Cursor rules or Host-specific protocol fork. */
export async function createCursorDelegationBridge(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  commandTimeoutMs = 65_000,
) {
  const cli = environment.CODEXHOST_CLI_PATH;
  const runtimeToken = environment.CODEXHOST_RUNTIME_TOKEN;
  if (
    !cli ||
    !environment.CODEXHOST_RUNTIME_ENDPOINT ||
    !runtimeToken ||
    !environment.CODEXHOST_THREAD_ID
  )
    return undefined;
  if (!path.isAbsolute(cli))
    throw new Error("Cursor delegation requires an absolute Host CLI path");
  const token = randomBytes(32).toString("base64url");
  const children = new Set<ChildProcess>();
  const servers = new Set<McpServer>();
  let closed = false;
  const redact = (value: string) => value.replaceAll(runtimeToken, "[redacted]");
  const run = (args: string[]) =>
    new Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>(
      (resolve) => {
        if (closed) {
          resolve({
            isError: true,
            content: [{ type: "text", text: "Cursor delegation bridge is closed" }],
          });
          return;
        }
        const child = execFile(
          cli,
          [...args, "--format", "compact"],
          {
            cwd,
            env: environment,
            windowsHide: true,
            timeout: commandTimeoutMs,
            killSignal: "SIGKILL",
            maxBuffer: 1_048_576,
          },
          (error, stdout, stderr) => {
            children.delete(child);
            resolve({
              ...(error ? { isError: true } : {}),
              content: [
                {
                  type: "text",
                  text: error
                    ? sanitizeDiagnosticTail(redact(stderr || "Host delegation command failed"))
                    : redact(stdout),
                },
              ],
            });
          },
        );
        children.add(child);
      },
    );
  const makeServer = () => {
    const server = new McpServer({ name: "codexhost-delegation", version: "1.0.0" });
    server.registerTool(
      "harness_list",
      {
        description:
          "Discover other Harnesses available for independent tasks in Codex Desktop. Use delegate_start only when the user asks to delegate work.",
        inputSchema: {},
      },
      () => run(["harness", "list"]),
    );
    server.registerTool(
      "harness_inspect",
      {
        description:
          "Read a Harness's native Models and Thinking choices. Use opaque IDs only when explicitly selecting; omission retains native defaults.",
        inputSchema: { harness: text, cwd: text.optional() },
      },
      ({ harness, cwd }) => run(["harness", "inspect", harness, ...optional("--cwd", cwd)]),
    );
    server.registerTool(
      "delegate_start",
      {
        description:
          "Start an independent task in another Harness when the user requests delegation. Returns immediately with a task link; use thread_wait for completion. Parent attribution and credentials come from this Cursor session. Do not delegate to Cursor: unattended inbound Cursor tasks are unsupported.",
        inputSchema: {
          harness: text,
          task: text,
          cwd: text.optional(),
          model: text.optional(),
          thinking: text.optional(),
          requestId: text.optional(),
        },
      },
      ({ harness, task, cwd, model, thinking, requestId }) =>
        run([
          "delegate",
          "start",
          "--harness",
          harness,
          "--task",
          task,
          ...optional("--cwd", cwd),
          ...optional("--model", model),
          ...optional("--thinking", thinking),
          ...optional("--request-id", requestId),
        ]),
    );
    server.registerTool(
      "thread_send",
      {
        description:
          "Send follow-up work to an existing idle task. Busy tasks must finish or be cancelled first.",
        inputSchema: { thread: text, message: text },
      },
      ({ thread, message }) => run(["thread", "send", thread, "--message", message]),
    );
    server.registerTool(
      "thread_cancel",
      {
        description:
          "Request cancellation of an existing task without deleting its history. Read or wait to confirm completion.",
        inputSchema: { thread: text },
      },
      ({ thread }) => run(["thread", "cancel", thread]),
    );
    const readSchema = {
      thread: text,
      view: z.enum(["result", "messages"]).optional(),
      cursor: text.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    };
    const readArgs = ({ thread, view, cursor, limit }: z.infer<z.ZodObject<typeof readSchema>>) => [
      thread,
      ...optional("--view", view),
      ...optional("--cursor", cursor),
      ...optional("--limit", limit),
    ];
    server.registerTool(
      "thread_read",
      {
        description:
          "Read another task without consuming its output or starting a turn. Use messages view for paginated conversation; result view returns status and latest result.",
        inputSchema: readSchema,
      },
      (input) => run(["thread", "read", ...readArgs(input)]),
    );
    server.registerTool(
      "thread_wait",
      {
        description:
          "Wait up to 60 seconds for another task. timedOut means it is still running; the returned snapshot already contains any available result.",
        inputSchema: { ...readSchema, timeoutMs: z.number().int().min(1).max(60_000).optional() },
      },
      (input) =>
        run(["thread", "wait", ...readArgs(input), ...optional("--timeout-ms", input.timeoutMs)]),
    );
    return server;
  };
  const http = createServer((request, response) => {
    if (
      closed ||
      request.url !== "/mcp" ||
      request.headers.origin ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const server = makeServer();
    servers.add(server);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    response.once("close", () => {
      servers.delete(server);
      void server.close();
    });
    void server
      // SDK optional callback declarations predate exactOptionalPropertyTypes.
      .connect(transport as Parameters<McpServer["connect"]>[0])
      .then(() => transport.handleRequest(request, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
        servers.delete(server);
        void server.close();
      });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Cursor delegation bridge could not bind");
  const descriptor: AcpMcpServer = {
    type: "http",
    name: "codexhost-delegation",
    url: `http://127.0.0.1:${address.port}/mcp`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
  };
  return {
    descriptor,
    async close() {
      if (closed) return;
      closed = true;
      for (const child of children) child.kill("SIGKILL");
      await Promise.allSettled([...servers].map((server) => server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
