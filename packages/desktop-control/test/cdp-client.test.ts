import { describe, expect, it } from "vitest";

import {
  CdpClient,
  getCdpBrowserVersion,
  listCdpTargets,
  type CdpFetch,
  type CdpSocketFactory,
} from "../src/index.js";

interface SocketEvent {
  data?: unknown;
}

type SocketListener = (event: SocketEvent) => void;

interface SocketRequest {
  id: number;
  method: string;
  sessionId?: string;
  params?: Record<string, unknown>;
}

class FakeSocket {
  readonly requests: SocketRequest[] = [];
  evaluation: unknown = { result: { type: "number", value: 42 } };
  releaseError = false;
  readonly #listeners = new Map<string, Set<SocketListener>>();

  constructor() {
    queueMicrotask(() => this.#emit("open", {}));
  }

  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: SocketListener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    const request = JSON.parse(data) as SocketRequest;
    this.requests.push(request);
    const result = request.method === "Runtime.evaluate" ? this.evaluation : { accepted: true };
    queueMicrotask(() => {
      if (request.method === "Target.setDiscoverTargets") {
        this.#emit("message", {
          data: JSON.stringify({
            method: "Target.targetCreated",
            params: { targetInfo: { targetId: "page-2" } },
          }),
        });
      }
      this.#emit("message", {
        data: JSON.stringify({
          id: request.id,
          ...(request.method === "Runtime.releaseObject" && this.releaseError
            ? { error: { code: -32000, message: "Execution context was destroyed" } }
            : { result }),
        }),
      });
    });
  }

  close(): void {
    this.#emit("close", {});
  }

  #emit(type: string, event: SocketEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

describe("CDP client", () => {
  it("validates and returns loopback page targets", async () => {
    const fetchImpl: CdpFetch = async (url) => ({
      ok: true,
      status: 200,
      async json() {
        expect(url).toBe("http://127.0.0.1:9222/json/list");
        return [
          {
            id: "page-1",
            type: "page",
            title: "Codex",
            url: "app://-/index.html",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-1",
          },
        ];
      },
    });

    await expect(listCdpTargets("http://127.0.0.1:9222", fetchImpl)).resolves.toEqual([
      {
        id: "page-1",
        type: "page",
        title: "Codex",
        url: "app://-/index.html",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-1",
      },
    ]);
  });

  it("skips targets that cannot be attached instead of failing discovery", async () => {
    const page = {
      id: "page-1",
      type: "page",
      title: "Codex",
      url: "app://-/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-1",
    };
    const fetchImpl: CdpFetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return [
          {
            id: "worker-1",
            type: "worker",
            title: "",
            url: "",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/worker-1",
          },
          { id: "page-2", type: "page", title: "Claimed", url: "app://-/index.html" },
          page,
        ];
      },
    });

    await expect(listCdpTargets("http://127.0.0.1:9222", fetchImpl)).resolves.toEqual([page]);
  });

  it("validates browser-level discovery metadata", async () => {
    const fetchImpl: CdpFetch = async (url) => ({
      ok: true,
      status: 200,
      async json() {
        expect(url).toBe("http://127.0.0.1:9222/json/version");
        return {
          Browser: "Chrome/150",
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/browser-1",
        };
      },
    });

    await expect(getCdpBrowserVersion("http://127.0.0.1:9222", fetchImpl)).resolves.toEqual({
      browser: "Chrome/150",
      protocolVersion: "1.3",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/browser-1",
    });
  });

  it("forwards an abort signal to CDP target discovery", async () => {
    const abort = new AbortController();
    const fetchImpl: CdpFetch = async (url, init) => {
      expect(url).toBe("http://127.0.0.1:9222/json/list");
      expect(init?.signal).toBe(abort.signal);
      return {
        ok: true,
        status: 200,
        async json() {
          return [];
        },
      };
    };
    await expect(listCdpTargets("http://127.0.0.1:9222", fetchImpl, abort.signal)).resolves.toEqual(
      [],
    );
  });

  it("rejects non-loopback discovery and target endpoints", async () => {
    await expect(listCdpTargets("http://example.com:9222")).rejects.toThrow("loopback");
    const fetchImpl: CdpFetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return [
          {
            id: "page-1",
            type: "page",
            title: "Codex",
            url: "app://-/index.html",
            webSocketDebuggerUrl: "ws://example.com/devtools/page/page-1",
          },
        ];
      },
    });
    await expect(listCdpTargets("http://127.0.0.1:9222", fetchImpl)).rejects.toThrow("loopback");
  });

  it.each([false, true])(
    "releases both exception handles without masking the evaluation error (release error=%s)",
    async (releaseError) => {
      const socket = new FakeSocket();
      socket.releaseError = releaseError;
      socket.evaluation = {
        result: { type: "object", subtype: "error", objectId: "result-error" },
        exceptionDetails: {
          text: "Uncaught",
          exception: { objectId: "exception-error", description: "Error: route unavailable" },
        },
      };
      const client = await CdpClient.connect("ws://127.0.0.1:9222/devtools/page/page-1", {
        socketFactory: () => socket,
      });
      try {
        await expect(client.evaluate("throw new Error('route unavailable')")).rejects.toThrow(
          "Error: route unavailable",
        );
        expect(
          socket.requests
            .filter(({ method }) => method === "Runtime.releaseObject")
            .map(({ params }) => params?.objectId),
        ).toEqual(["result-error", "exception-error"]);
        socket.evaluation = { result: { type: "number", value: 42 } };
        await expect(client.evaluate("6 * 7")).resolves.toBe(42);
      } finally {
        client.close();
      }
    },
  );

  it.each([
    {
      evaluation: {
        result: { objectId: "shared-error" },
        exceptionDetails: { text: "Uncaught", exception: { objectId: "shared-error" } },
      },
      ids: ["shared-error"],
      error: "Uncaught",
    },
    {
      evaluation: { result: { type: "object", objectId: "unserializable" } },
      ids: ["unserializable"],
      error: "Runtime.evaluate did not return a value",
    },
    {
      evaluation: {
        result: { type: "string", value: "failure" },
        exceptionDetails: { text: "Uncaught" },
      },
      ids: [],
      error: "Uncaught",
    },
    { evaluation: null, ids: [], error: "Runtime.evaluate returned an invalid result" },
  ])("cleans up returned handles for $error ($ids)", async ({ evaluation, ids, error }) => {
    const socket = new FakeSocket();
    socket.evaluation = evaluation;
    const client = await CdpClient.connect("ws://127.0.0.1:9222/devtools/page/page-1", {
      socketFactory: () => socket,
    });
    try {
      await expect(client.evaluate("expression")).rejects.toThrow(error);
      expect(
        socket.requests
          .filter(({ method }) => method === "Runtime.releaseObject")
          .map(({ params }) => params?.objectId),
      ).toEqual(ids);
    } finally {
      client.close();
    }
  });

  it("correlates commands and unwraps Runtime.evaluate values", async () => {
    const socket = new FakeSocket();
    const socketFactory: CdpSocketFactory = () => socket;
    const client = await CdpClient.connect("ws://127.0.0.1:9222/devtools/page/page-1", {
      socketFactory,
    });

    await expect(client.command("Runtime.enable")).resolves.toEqual({ accepted: true });
    await expect(client.evaluate<number>("6 * 7")).resolves.toBe(42);
    expect(socket.requests.some(({ method }) => method === "Runtime.releaseObject")).toBe(false);

    const events: unknown[] = [];
    client.on("Target.targetCreated", (params) => events.push(params));
    await client.command("Target.setDiscoverTargets", { discover: true });
    expect(events).toEqual([{ targetInfo: { targetId: "page-2" } }]);
    await expect(client.sessionCommand("session-1", "Runtime.evaluate")).resolves.toEqual({
      result: { type: "number", value: 42 },
    });
    expect(socket.requests.at(-1)?.sessionId).toBe("session-1");
    client.close();
  });
});
