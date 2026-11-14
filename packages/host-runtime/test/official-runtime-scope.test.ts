import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  OfficialRuntimeClient,
  OfficialRuntimeScope,
} from "../src/codex-runtime/official-runtime-scope.js";
import type { OwnedOfficialBackend } from "../src/codex-runtime/official-runtime-owner.js";
import type {
  OfficialAppServerExit,
  OfficialAppServerConnection,
} from "../src/official-app-server-connection.js";
import type { JsonObject } from "@codexhost/protocol-core";
import { JsonLineCollector } from "./app-server-host-fixture.js";

function fixture() {
  const exit = Promise.withResolvers<OfficialAppServerExit>();
  const backend: OwnedOfficialBackend = {
    closed: exit.promise,
    start: vi.fn(async () => {}),
    connect: async () => {
      throw new Error("No client expected");
    },
    stop: vi.fn(async () => {
      exit.resolve({ code: 0, signal: null });
    }),
  };
  const createBackend = vi.fn(() => backend);
  const scope = new OfficialRuntimeScope({
    permanentHome: "/synthetic/home",
    createBackend,
    diagnosticOutput: new PassThrough(),
  });
  return { scope, backend, createBackend, exit };
}

describe("Desktop initialization without native admission", () => {
  const params = { clientInfo: { name: "codex_desktop", version: "synthetic" } };

  it("returns Host metadata without starting Codex or publishing ready", async () => {
    const f = fixture();
    const client = new OfficialRuntimeClient({ scope: f.scope, output: async () => {} });
    try {
      await expect(client.initializeProtocol(params)).resolves.toEqual({
        result: {
          userAgent: "codexhost",
          codexHome: "/synthetic/home",
          platformFamily: process.platform === "win32" ? "windows" : "unix",
          platformOs:
            process.platform === "darwin"
              ? "macos"
              : process.platform === "win32"
                ? "windows"
                : process.platform,
        },
      });
      expect(f.scope.gate.phase).toBe("unavailable");
      expect(f.createBackend).not.toHaveBeenCalled();
      await expect(client.request("model/list", {})).rejects.toThrow("unavailable");
      await f.scope.close();
      await expect(client.initializeProtocol(params)).rejects.toThrow("unavailable");
      await client.close();
      await expect(client.initializeProtocol(params)).rejects.toThrow("unavailable");
    } finally {
      await client.close();
      await f.scope.close();
    }
  });
});

describe("official Runtime Scope terminal shutdown", () => {
  it("retires startup questions after failed first initialization before the next generation", async () => {
    let generation = 0;
    const scope = new OfficialRuntimeScope({
      permanentHome: "/synthetic/home",
      diagnosticOutput: new PassThrough(),
      createBackend: () => {
        const current = ++generation;
        const stopped = Promise.withResolvers<OfficialAppServerExit>();
        const connections: OfficialAppServerConnection[] = [];
        return {
          closed: stopped.promise,
          start: async () => {},
          connect: async () => {
            const stdin = new PassThrough(),
              stdout = new PassThrough(),
              stderr = new PassThrough();
            const exited = Promise.withResolvers<OfficialAppServerExit>();
            const requests = new JsonLineCollector(stdin);
            const connection = {
              stdin,
              stdout,
              stderr,
              closed: exited.promise,
              close() {
                stdout.end();
                exited.resolve({ code: 0, signal: null });
              },
            };
            connections.push(connection);
            stdin.on("data", () => {
              for (const request of requests.messages.splice(0)) {
                if (request.method !== "initialize") continue;
                if (current === 1) {
                  stdout.write(
                    `${JSON.stringify({
                      method: "item/completed",
                      params: {
                        threadId: "old-thread",
                        turnId: "old-turn",
                        item: {
                          id: "old-question",
                          type: "agentMessage",
                          delivery: "async",
                          questions: [{ title: "Old question?" }],
                        },
                      },
                    })}\n`,
                  );
                  setImmediate(() =>
                    stdout.write(
                      `${JSON.stringify({ id: request.id, error: { code: -32603, message: "Initialization failed" } })}\n`,
                    ),
                  );
                } else stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
              }
            });
            return connection;
          },
          stop: async () => {
            for (const connection of connections) connection.close();
            stopped.resolve({ code: 0, signal: null });
          },
        };
      },
    });
    const client = scope.attach(async ({ value }) => {
      const message = value as JsonObject;
      if (typeof message.method === "string")
        scope.asyncQuestions.observe(message.method, (message.params ?? {}) as JsonObject);
    });
    client.configure({
      clientInfo: { name: "fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    try {
      await expect(scope.start()).rejects.toThrow("unavailable");
      expect(scope.gate.phase).toBe("unavailable");
      await scope.stop();
      expect.soft(scope.asyncQuestions.pending("old-thread", "old:")).toEqual([]);
      await scope.start();
      expect(scope.owner.generation).toBe(2);
      expect(scope.gate.phase).toBe("ready");
      expect(scope.asyncQuestions.pending("old-thread", "new:")).toEqual([]);
    } finally {
      await scope.close();
      client.close();
    }
  });

  it("owns native questions until the backend generation stops", async () => {
    const f = fixture();
    await f.scope.start();
    try {
      f.scope.asyncQuestions.observe("item/completed", {
        threadId: "thread",
        turnId: "turn",
        item: {
          id: "question",
          type: "agentMessage",
          delivery: "async",
          questions: [{ title: "Continue?" }],
        },
      });
      const client = new OfficialRuntimeClient({ scope: f.scope, output: async () => {} });
      await client.close();
      expect(f.scope.asyncQuestions.pending("thread", "delegate:")).toHaveLength(1);
      const question = f.scope.asyncQuestions.pending("thread", "delegate:")[0];
      if (!question) throw new Error("Missing native question");
      const request = vi.fn(async (method: string) => {
        if (method === "thread/turns/list")
          return {
            result: { data: [{ id: "turn", status: "inProgress", items: [] }], nextCursor: null },
          };
        throw new Error("Unknown delivery");
      });
      const answer = { answers: { [question.question.id]: { answers: ["Continue"] } } };
      await expect(
        f.scope.asyncQuestions.respond(question.requestId, "thread", answer, "delegate:", request),
      ).rejects.toThrow("Unknown delivery");
      const borrower = new OfficialRuntimeClient({ scope: f.scope, output: async () => {} });
      await borrower.close();
      await expect(
        f.scope.asyncQuestions.respond(question.requestId, "thread", answer, "delegate:", request),
      ).rejects.toThrow("unknown");
      expect(request).toHaveBeenCalledTimes(2);
      await f.scope.stop();
      expect(f.scope.asyncQuestions.pending("thread", "delegate:")).toEqual([]);
    } finally {
      await f.scope.close();
    }
  });

  it("rejects a late Account-runtime owner start after Scope close", async () => {
    const f = fixture();
    await f.scope.close();
    try {
      await expect(f.scope.owner.start()).rejects.toThrow("unavailable");
      expect(f.createBackend).not.toHaveBeenCalled();
    } finally {
      await f.scope.owner.stop();
    }
  });

  it("retries failed close while retaining backend ownership", async () => {
    const f = fixture();
    const stop = vi.spyOn(f.backend, "stop");
    stop
      .mockRejectedValueOnce(new Error("unconfirmed"))
      .mockRejectedValueOnce(new Error("unconfirmed"));
    await f.scope.start();
    try {
      await expect(f.scope.close()).rejects.toThrow("unavailable");
      await expect(f.scope.close()).rejects.toThrow("unavailable");
      expect(stop).toHaveBeenCalledTimes(2);
      await f.scope.close();
      expect(stop).toHaveBeenCalledTimes(3);
    } finally {
      stop.mockReset().mockImplementation(async () => {
        f.exit.resolve({ code: 0, signal: null });
      });
      await f.scope.owner.stop();
    }
  });

  it("does not publish ready when close races backend startup", async () => {
    const f = fixture();
    const started = Promise.withResolvers<undefined>();
    vi.spyOn(f.backend, "start").mockReturnValue(started.promise);
    const phases: string[] = [];
    f.scope.gate.subscribe(() => {
      phases.push(f.scope.gate.phase);
    });
    const starting = f.scope.start();
    const outcome = expect(starting).rejects.toThrow("unavailable");
    const closing = f.scope.close();
    started.resolve(undefined);
    await closing;
    await outcome;
    expect(phases).not.toContain("ready");
  });
});
