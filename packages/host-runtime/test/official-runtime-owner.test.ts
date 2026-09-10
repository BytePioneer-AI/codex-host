import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import {
  OfficialRuntimeOwner,
  type OwnedOfficialBackend,
} from "../src/codex-runtime/official-runtime-owner.js";
import { OfficialWorkGate } from "../src/codex-runtime/official-work-gate.js";
import type { OfficialAppServerExit } from "../src/official-app-server-connection.js";

function fixture() {
  let live = 0;
  let peak = 0;
  const events: string[] = [];
  const backends: ReturnType<typeof backend>[] = [];
  function backend() {
    const exit = Promise.withResolvers<OfficialAppServerExit>();
    const connections: ReturnType<typeof connection>[] = [];
    let running = false;
    let rejectStop = false;
    let rejectStart = false;
    function connection() {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const closed = Promise.withResolvers<OfficialAppServerExit>();
      const requests: JsonObject[] = [];
      let input = "";
      const emit = (value: JsonObject) => stdout.write(`${JSON.stringify(value)}\n`);
      let respond = (request: JsonObject): JsonObject | null => {
        if (!request.method) return null;
        const params = request.params as JsonObject;
        if (request.method === "initialize")
          return { id: request.id ?? null, result: { userAgent: "synthetic" } };
        if (request.method === "initialized") return null;
        if (["thread/start", "thread/resume", "thread/fork"].includes(String(request.method)))
          return {
            id: request.id ?? null,
            result: { thread: { id: params.threadId ?? "thread-one", status: { type: "idle" } } },
          };
        if (request.method === "turn/start")
          return {
            id: request.id ?? null,
            result: { turn: { id: "turn-one", status: "inProgress" } },
          };
        return { id: request.id ?? null, result: { data: [] } };
      };
      stdin.on("data", (chunk: Buffer) => {
        input += chunk.toString();
        let newline: number;
        while ((newline = input.indexOf("\n")) >= 0) {
          const request = JSON.parse(input.slice(0, newline)) as JsonObject;
          input = input.slice(newline + 1);
          requests.push(request);
          const response = respond(request);
          if (response) emit(response);
        }
      });
      const close = vi.fn(() => {
        stdin.end();
        stdout.end();
        stderr.end();
        closed.resolve({ code: 0, signal: null });
      });
      return {
        stdin,
        stdout,
        stderr,
        closed: closed.promise,
        close,
        requests,
        emit,
        setResponse: (next: typeof respond) => {
          respond = next;
        },
      };
    }
    const native: OwnedOfficialBackend = {
      closed: exit.promise,
      async start() {
        if (running) throw new Error("Duplicate native start");
        running = true;
        live++;
        peak = Math.max(peak, live);
        events.push("start");
        if (rejectStart) throw new Error("Synthetic startup failure after spawn");
      },
      async connect() {
        if (!running) throw new Error("Native backend is stopped");
        const value = connection();
        connections.push(value);
        return value;
      },
      async stop() {
        if (rejectStop) throw new Error("Synthetic unconfirmed exit");
        if (running) {
          live--;
          running = false;
          events.push("exit");
        }
        for (const client of connections) client.close();
        exit.resolve({ code: 0, signal: null });
      },
    };
    return {
      native,
      connections,
      failStop: (fail: boolean) => {
        rejectStop = fail;
      },
      failStart: () => {
        rejectStart = true;
      },
    };
  }
  const gate = new OfficialWorkGate();
  const create = vi.fn(() => {
    const value = backend();
    backends.push(value);
    return value.native;
  });
  const owner = new OfficialRuntimeOwner({
    createBackend: create,
    diagnosticOutput: new PassThrough(),
    gate,
  });
  const attach = () => {
    const output: JsonObject[] = [];
    const client = owner.attach(async ({ value }) => {
      output.push(value as JsonObject);
    });
    return { client, output };
  };
  const native = (generation = 0) => {
    const value = backends[generation];
    if (!value) throw new Error("Missing synthetic backend");
    return value;
  };
  const connection = (generation = 0, index = 0) => {
    const value = native(generation).connections[index];
    if (!value) throw new Error("Missing synthetic connection");
    return value;
  };
  return { owner, gate, create, attach, native, connection, events, peak: () => peak };
}
const initialization = {
  clientInfo: { name: "synthetic", version: "1" },
  capabilities: { experimentalApi: true },
};

describe("single official runtime owner", () => {
  it("shares one process across clients and reinitializes without duplicate Desktop responses", async () => {
    const f = fixture();
    const a = f.attach();
    const b = f.attach();
    try {
      await f.owner.start();
      await Promise.all([a.client.initialize(initialization), b.client.initialize(initialization)]);
      f.gate.initialized();
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.native().connections).toHaveLength(2);
      const change = f.gate.beginChange();
      await f.owner.stop();
      await f.owner.start();
      change.finish("ready");
      expect(f.peak()).toBe(1);
      expect(f.events).toEqual(["start", "exit", "start"]);
      expect(f.native(1).connections).toHaveLength(2);
      for (const connection of f.native(1).connections)
        expect(connection.requests.map((r) => r.method)).toEqual(["initialize", "initialized"]);
      expect(a.output).toEqual([]);
      expect(b.output).toEqual([]);
    } finally {
      await f.owner.stop();
    }
  });

  it("resumes the original Thread lazily, preserving options without history/path or Turn replay", async () => {
    const f = fixture();
    const a = f.attach();
    try {
      await f.owner.start();
      await a.client.initialize(initialization);
      f.gate.initialized();
      await a.client.request("thread/resume", {
        threadId: "original",
        path: "synthetic-path",
        history: [],
        model: "original-model",
        cwd: "synthetic-cwd",
      });
      const change = f.gate.beginChange();
      await f.owner.stop();
      await f.owner.start();
      change.finish("ready");
      expect(f.connection(1).requests.map((r) => r.method)).toEqual(["initialize", "initialized"]);
      await a.client.request("turn/start", { threadId: "original", input: [] });
      expect(f.connection(1).requests.map((r) => r.method)).toEqual([
        "initialize",
        "initialized",
        "thread/resume",
        "turn/start",
      ]);
      expect(f.connection(1).requests[2]?.params).toEqual({
        threadId: "original",
        model: "original-model",
        cwd: "synthetic-cwd",
        excludeTurns: true,
      });
      expect(f.gate.busy).toBe(true);
      f.connection(1).emit({
        method: "turn/completed",
        params: { threadId: "original", turn: { id: "turn-one", status: "completed" } },
      });
      await vi.waitFor(() => expect(f.gate.busy).toBe(false));
    } finally {
      await f.owner.stop();
    }
  });

  it("restores two clients to the same ID without account binding or Fork", async () => {
    const f = fixture();
    const a = f.attach();
    const b = f.attach();
    try {
      await f.owner.start();
      await a.client.initialize(initialization);
      await b.client.initialize(initialization);
      f.gate.initialized();
      await a.client.request("thread/resume", { threadId: "shared" });
      await b.client.request("thread/resume", { threadId: "shared" });
      const change = f.gate.beginChange();
      await f.owner.stop();
      await f.owner.start();
      change.finish("ready");
      await a.client.request("turn/interrupt", { threadId: "shared", turnId: "old" });
      await b.client.request("turn/interrupt", { threadId: "shared", turnId: "old" });
      for (const connection of f.native(1).connections) {
        expect(
          connection.requests.filter((r) => r.method === "thread/resume").map((r) => r.params),
        ).toEqual([{ threadId: "shared", excludeTurns: true }]);
        expect(connection.requests.some((r) => r.method === "thread/fork")).toBe(false);
      }
      expect(f.peak()).toBe(1);
    } finally {
      await f.owner.stop();
    }
  });

  it("isolates one Thread restoration failure and does not resume for metadata writes", async () => {
    const f = fixture();
    const a = f.attach();
    const b = f.attach();
    try {
      await f.owner.start();
      await a.client.initialize(initialization);
      await b.client.initialize(initialization);
      f.gate.initialized();
      await a.client.request("thread/resume", { threadId: "unavailable-thread" });
      const change = f.gate.beginChange();
      await f.owner.stop();
      await f.owner.start();
      change.finish("ready");
      f.connection(1).setResponse((request) => ({
        id: request.id ?? null,
        ...(request.method === "thread/resume"
          ? { error: { code: -1, message: "synthetic failure" } }
          : { result: {} }),
      }));
      await a.client.request("thread/name/set", {
        threadId: "unavailable-thread",
        name: "renamed",
      });
      expect(f.connection(1).requests.some((r) => r.method === "thread/resume")).toBe(false);
      await expect(
        a.client.request("turn/start", { threadId: "unavailable-thread", input: [] }),
      ).rejects.toThrow("restoration failed");
      await b.client.request("model/list", {});
      expect(f.gate.phase).toBe("ready");
      expect(f.gate.busy).toBe(false);
    } finally {
      await f.owner.stop();
    }
  });

  it("keeps ownership after a failed stop and refuses a competing backend", async () => {
    const f = fixture();
    const a = f.attach();
    await f.owner.start();
    await a.client.initialize(initialization);
    f.gate.initialized();
    f.native().failStop(true);
    await expect(f.owner.stop()).rejects.toThrow("unavailable");
    await expect(f.owner.start()).rejects.toThrow("unavailable");
    expect(f.create).toHaveBeenCalledTimes(1);
    f.native().failStop(false);
    await f.owner.stop();
    await f.owner.start();
    expect(f.peak()).toBe(1);
    await f.owner.stop();
  });

  it("rejects retired server replies and does not close another Desktop client", async () => {
    const f = fixture();
    const a = f.attach();
    const b = f.attach();
    try {
      await f.owner.start();
      await a.client.initialize(initialization);
      await b.client.initialize(initialization);
      f.gate.initialized();
      f.connection().emit({
        id: 7,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-one" },
      });
      await vi.waitFor(() => expect(a.output).toHaveLength(1));
      const id = a.output[0]?.id;
      if (typeof id !== "string") throw new Error("Missing projected server ID");
      await f.owner.stop();
      await f.owner.start();
      await expect(a.client.send({ id, result: {} })).rejects.toThrow(
        "Retired official server request",
      );
      expect(f.connection(1).requests).not.toContainEqual({ id: 7, result: {} });
      // Both original Desktop-facing session objects are still attached.
      f.gate.initialized();
      await b.client.request("model/list", {});
      expect(f.native(1).connections).toHaveLength(2);
    } finally {
      await f.owner.stop();
    }
  });

  it("does not lose the first request's lease when a duplicate ID is rejected", async () => {
    const f = fixture();
    const a = f.attach();
    try {
      await f.owner.start();
      await a.client.initialize(initialization);
      f.gate.initialized();
      f.connection().setResponse(() => null);
      await a.client.send({ id: 5, method: "model/list", params: {} });
      await expect(a.client.send({ id: 5, method: "model/list", params: {} })).rejects.toThrow(
        "Duplicate",
      );
      expect(f.gate.busy).toBe(true);
      f.connection().emit({ id: 5, result: {} });
      await vi.waitFor(() => expect(f.gate.busy).toBe(false));
    } finally {
      await f.owner.stop();
    }
  });

  it("fails pending work explicitly on retirement instead of replaying it", async () => {
    const f = fixture();
    const a = f.attach();
    try {
      await f.owner.start();
      await a.client.initialize(initialization);
      f.gate.initialized();
      f.connection().setResponse(() => null);
      await a.client.send({ id: 9, method: "command/exec", params: { command: ["synthetic"] } });
      await f.owner.stop();
      await f.owner.start();
      expect(a.output).toContainEqual({
        id: 9,
        error: { code: -32001, message: "Official connection retired; retry explicitly" },
      });
      expect(f.connection(1).requests.some((r) => r.method === "command/exec")).toBe(false);
    } finally {
      await f.owner.stop();
    }
  });
});
