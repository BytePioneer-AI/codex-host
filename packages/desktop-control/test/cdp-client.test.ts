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

class FakeSocket {
  readonly requests: Array<{ id: number; method: string; sessionId?: string }> = [];
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
    const request = JSON.parse(data) as { id: number; method: string; sessionId?: string };
    this.requests.push(request);
    const result =
      request.method === "Runtime.evaluate"
        ? { result: { type: "number", value: 42 } }
        : { accepted: true };
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
        data: JSON.stringify({ id: request.id, result }),
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

  it("correlates commands and unwraps Runtime.evaluate values", async () => {
    const socket = new FakeSocket();
    const socketFactory: CdpSocketFactory = () => socket;
    const client = await CdpClient.connect("ws://127.0.0.1:9222/devtools/page/page-1", {
      socketFactory,
    });

    await expect(client.command("Runtime.enable")).resolves.toEqual({ accepted: true });
    await expect(client.evaluate<number>("6 * 7")).resolves.toBe(42);

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
