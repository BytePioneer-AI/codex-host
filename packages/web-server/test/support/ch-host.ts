/** Real CH wire-shape fixture, not an independent Harness implementation. */
import { createServer } from "node:http";
import { basename } from "node:path";
import { runInNewContext } from "node:vm";
import { WebSocketServer } from "ws";
import type { ChHostClient, ChPinChange, ChProjectSnapshot } from "../../src/ch-host-client.ts";
import type { ChThread } from "../../src/ch-thread-view.ts";
import { decodeHarnessPluginRoute } from "@codexhost/shared-contracts";

export class FakeChHost implements ChHostClient {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly threads = new Map<string, ChThread>();
  readonly modes = new Map<string, string>();
  readonly projectSnapshot: ChProjectSnapshot = { projects: [], assignments: {}, projectless: [] };
  async projects(): Promise<ChProjectSnapshot> {
    return structuredClone(this.projectSnapshot);
  }
  pinnedIds: string[] = [];
  pinError: string | undefined;
  readonly pinWrites: ChPinChange[] = [];
  readonly pinServiceCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  async pins(change?: ChPinChange): Promise<string[]> {
    if (this.closed || this.pinError) throw new Error(this.pinError ?? "Host offline");
    if (change) {
      this.pinWrites.push(change);
      this.pinnedIds = this.pinnedIds.filter((id) => id !== change.threadId);
      if (change.pinned) this.pinnedIds.push(change.threadId);
    }
    return [...this.pinnedIds];
  }
  closed = false;
  historyError: string | undefined;
  readonly inspection = {
    status: "ready",
    catalog: {
      models: [{ ref: { id: "native" }, label: "Native Model" }],
      defaultModel: { id: "native" },
      thinkingOptions: [],
    },
    permissionModes: {
      modes: [
        { id: "ask", label: "Ask" },
        { id: "auto", label: "Native Auto" },
      ],
      defaultModeId: "ask",
    },
    capabilities: {
      configuration: { selectModel: true, selectThinkingOption: false, selectPermissionMode: true },
      history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    },
  };
  add(id: string, cwd: string, title = id, selectedProject = true): ChThread {
    if (selectedProject) {
      this.projectSnapshot.projects.push({
        id: "project-" + id,
        name: basename(cwd),
        rootPaths: [cwd],
      });
      this.projectSnapshot.assignments[id] = "project-" + id;
    } else this.projectSnapshot.projectless.push(id);
    const row: ChThread = {
      id,
      cwd,
      modelProvider: "codexhost",
      name: title,
      createdAt: 1000,
      updatedAt: 2000,
      status: { type: "idle" },
      turns: [
        {
          id: "history-" + id,
          status: "completed",
          items: [
            {
              id: "u-" + id,
              type: "userMessage",
              content: [{ type: "text", text: "earlier question" }],
            },
            { id: "a-" + id, type: "agentMessage", text: "existing CH answer" },
          ],
        },
      ],
    };
    this.threads.set(id, row);
    return row;
  }
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) throw new Error("Host offline");
    this.requests.push({ method, params });
    let value: unknown;
    const row = this.threads.get(String(params.threadId));
    switch (method) {
      case "thread/list":
        value = { data: params.archived ? [] : [...this.threads.values()], nextCursor: null };
        break;
      case "codexhost/harness/plugins/list":
        value = {
          plugins: [
            {
              id: "fake",
              name: "CH Harness",
              version: "1.0.0",
              icon:
                "data:image/svg+xml;base64," +
                Buffer.from(
                  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#00aa88"/></svg>',
                ).toString("base64"),
            },
          ],
        };
        break;
      case "codexhost/harness/inspect":
        value = this.inspection;
        break;
      case "codexhost/thread/ownership/list":
        value = {
          threads: (params.threadIds as string[]).map((id) => ({
            threadId: id,
            owner: "external",
            harnessId: "fake",
          })),
        };
        break;
      case "codexhost/thread/inspect":
        if (!row) throw new Error("Missing CH Thread");
        value = {
          owner: "external",
          harnessId: "fake",
          transportModelId: "codexhost/plugin",
          effectiveModel: { id: "native" },
          effectivePermissionModeId: this.modes.get(row.id) ?? "ask",
          locked: true,
          history: this.inspection.capabilities.history,
        };
        break;
      case "thread/read":
        if (!row) throw new Error("Missing CH Thread");
        if (params.includeTurns === true)
          throw new Error("Paginated External Threads require thread/turns/list");
        value = { thread: { ...structuredClone(row), turns: [] } };
        break;
      case "thread/turns/list": {
        if (this.historyError) throw new Error(this.historyError);
        if (!row) throw new Error("Missing CH Thread");
        if (params.itemsView !== "full") throw new Error("Full history items must be requested");
        const ordered = params.sortDirection === "asc" ? row.turns : [...row.turns].reverse();
        const anchor = params.cursor ? String(params.cursor) : undefined;
        const index = anchor ? ordered.findIndex((turn) => turn.id === anchor) + 1 : 0;
        const page = ordered.slice(index, index + Number(params.limit ?? 25));
        value = {
          data: structuredClone(page),
          nextCursor: index + page.length < ordered.length ? page.at(-1)?.id : null,
          backwardsCursor: page[0]?.id ?? null,
        };
        break;
      }
      case "thread/start": {
        const route = decodeHarnessPluginRoute(params.model);
        if (route?.harnessId !== "fake") throw new Error("Wrong Harness route");
        const created = this.add(
          "canonical-" + (this.threads.size + 1),
          String(params.cwd),
          "Web-created CH Thread",
          false,
        );
        created.turns = [];
        value = { thread: structuredClone(created) };
        break;
      }
      case "turn/start": {
        if (!row) throw new Error("Missing CH Thread");
        const id = "turn-" + (row.turns.length + 1);
        const input = params.input as Array<{ text: string }>;
        row.turns.push({
          id,
          status: "completed",
          items: [
            { id: id + "-user", type: "userMessage", content: input },
            {
              id: id + "-agent",
              type: "agentMessage",
              text: "CH response: " + input.map((p) => p.text).join(""),
            },
          ],
        });
        value = { turn: { id, status: "completed" } };
        break;
      }
      case "codexhost/thread/permission-mode/select":
        this.modes.set(String(params.threadId), String(params.permissionModeId));
        value = { effectivePermissionModeId: params.permissionModeId };
        break;
      case "codexhost/thread/model/select":
        value = { effectiveModel: params.model };
        break;
      case "thread/name/set":
        if (row) row.name = String(params.name);
        value = {};
        break;
      case "turn/interrupt":
        value = {};
        break;
      default:
        throw new Error("Unhandled CH fixture method: " + method);
    }
    return value as T;
  }
  close() {
    this.closed = true;
  }
}

/** Browser acceptance reaches the production Desktop transport through an isolated fake CDP peer. */
export async function startFakeChDebugger(host: FakeChHost) {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify([
        {
          id: "fixture",
          type: "page",
          title: "Fixture",
          url: "app://codex/index.html",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/debug`,
        },
      ]),
    );
  });
  const sockets = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No debugger address");
  const port = address.port;
  sockets.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as {
        id: number;
        method: string;
        params: { expression: string };
      };
      if (frame.method !== "Runtime.evaluate") {
        socket.send(JSON.stringify({ id: frame.id, result: {} }));
        return;
      }
      const window = {
        __codexhostRendererBindingProbeV1: {},
        __codexhostHostRoutingV1: {
          knownHostIds: () => ["local"],
          forHost: () => ({
            manager: {
              runtime: {
                pinnedThreads: async () => ({
                  list: async (params: Record<string, unknown>) => {
                    host.pinServiceCalls.push({ method: "list", params });
                    return { threadIds: await host.pins() };
                  },
                  set: async (params: Record<string, unknown>) => {
                    host.pinServiceCalls.push({ method: "set", params });
                    await host.pins({
                      threadId: String(params.threadId),
                      pinned: params.pinned === true,
                    });
                    return { success: true };
                  },
                }),
              },
              threadWorkspaceStorage: {
                storage: {
                  readGlobalState: async (key: string) => {
                    if (key === "local-projects")
                      return Object.fromEntries(
                        host.projectSnapshot.projects.map((project) => [project.id, project]),
                      );
                    if (key === "project-order")
                      return host.projectSnapshot.projects.map((project) => project.id);
                    if (key === "projectless-thread-ids") return host.projectSnapshot.projectless;
                    if (key === "thread-project-assignments")
                      return Object.fromEntries(
                        Object.entries(host.projectSnapshot.assignments).map(([id, projectId]) => [
                          id,
                          { projectKind: "local", projectId },
                        ]),
                      );
                    throw new Error("Unknown native project key");
                  },
                },
              },
              sendRequest: (method: string, params: Record<string, unknown>) =>
                host.request(method, params),
            },
          }),
        },
      };
      void Promise.resolve(runInNewContext(frame.params.expression, { window })).then(
        (value) =>
          socket.send(
            JSON.stringify({ id: frame.id, result: { result: { type: "object", value } } }),
          ),
        (error) =>
          socket.send(
            JSON.stringify({ id: frame.id, result: { exceptionDetails: { text: String(error) } } }),
          ),
      );
    }),
  );
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets.clients) socket.close();
      await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
    },
  };
}
