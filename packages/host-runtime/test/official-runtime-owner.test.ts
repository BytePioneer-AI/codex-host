import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import {
  OfficialRuntimeOwner,
  type OwnedOfficialBackend,
} from "../src/codex-runtime/official-runtime-owner.js";
import { OfficialWorkGate } from "../src/codex-runtime/official-work-gate.js";
import { createOwnedLoopbackBackend } from "../src/codex-runtime/owned-official-backends.js";
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
      closeUnexpectedly: () => exit.resolve({ code: 1, signal: null }),
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

it.each(["request", "send"] as const)(
  "inherits confirmed source Model settings when a native Fork omits them through %s",
  async (transport) => {
    const f = fixture();
    const { client, output } = f.attach();
    try {
      await f.owner.start();
      await client.initialize(initialization);
      f.gate.initialized();
      f.connection().setResponse((request) => ({
        id: request.id ?? null,
        result: {
          thread: { id: request.method === "thread/fork" ? "child" : "source" },
          model: "source-model",
          modelProvider: "source-provider",
          reasoningEffort: "high",
          serviceTier: "priority",
          approvalPolicy: "never",
          developerInstructions: "Source-only instructions",
        },
      }));
      await client.request("thread/resume", { threadId: "source", excludeTurns: true });
      const params = {
        threadId: "source",
        lastTurnId: "source-turn",
        model: null,
        cwd: "/new-worktree",
        config: { futureSetting: true },
        futureForkOption: { preserve: true },
      };
      const original = structuredClone(params);
      if (transport === "request") await client.request("thread/fork", params);
      else {
        await client.send({ id: "fork", method: "thread/fork", params });
        await vi.waitFor(() => expect(output.some(({ id }) => id === "fork")).toBe(true));
      }
      expect(f.connection().requests.at(-1)?.params).toEqual({
        ...params,
        model: "source-model",
        modelProvider: "source-provider",
        serviceTier: "priority",
        config: { futureSetting: true, model_reasoning_effort: "high" },
      });
      expect(params).toEqual(original);
    } finally {
      await f.owner.stop();
      client.close();
    }
  },
);

it.each<JsonObject>([
  { model: "selected-model" },
  { modelProvider: "selected-provider" },
  { config: { model: "selected-model" } },
  { config: { model_provider: "selected-provider" } },
  { config: ["future-config-shape"] },
  { path: "/different-source.jsonl" },
  { history: [] },
])(
  "keeps explicit native Fork selections and alternate sources unchanged: %j",
  async (overrides) => {
    const f = fixture();
    const { client } = f.attach();
    try {
      await f.owner.start();
      await client.initialize(initialization);
      f.gate.initialized();
      f.connection().setResponse((request) => ({
        id: request.id ?? null,
        result: {
          thread: { id: request.method === "thread/fork" ? "child" : "source" },
          model: "source-model",
          modelProvider: "source-provider",
          reasoningEffort: "high",
          serviceTier: "priority",
        },
      }));
      await client.request("thread/resume", { threadId: "source" });
      const params = { threadId: "source", beforeTurnId: "boundary", ...overrides };
      await client.request("thread/fork", params);
      expect(f.connection().requests.at(-1)?.params).toEqual(params);
      expect(f.connection().requests).toHaveLength(4);
    } finally {
      await f.owner.stop();
      client.close();
    }
  },
);

it.each([
  { serviceTier: null, config: { model_reasoning_effort: null } },
  { config: { model_reasoning_effort: "low", service_tier: null } },
])("preserves explicit native Fork Thinking and Fast settings: %j", async (overrides) => {
  const f = fixture();
  const { client } = f.attach();
  try {
    await f.owner.start();
    await client.initialize(initialization);
    f.gate.initialized();
    f.connection().setResponse((request) => ({
      id: request.id ?? null,
      result: {
        thread: { id: request.method === "thread/fork" ? "child" : "source" },
        model: "source-model",
        reasoningEffort: "high",
        serviceTier: "priority",
      },
    }));
    await client.request("thread/resume", { threadId: "source" });
    const params = { threadId: "source", ...overrides };
    await client.request("thread/fork", params);
    expect(f.connection().requests.at(-1)?.params).toEqual({ ...params, model: "source-model" });
  } finally {
    await f.owner.stop();
    client.close();
  }
});

it.each([
  {
    settings: { model: "latest-model", effort: "low", serviceTier: null },
    expected: {
      model: "latest-model",
      serviceTier: null,
      config: { model_reasoning_effort: "low" },
    },
  },
  { settings: { model: "latest-model" }, expected: { model: "latest-model" } },
])(
  "uses native settings updates across clients when forking: %j",
  async ({ settings, expected }) => {
    const f = fixture();
    const source = f.attach();
    const other = f.attach();
    try {
      await f.owner.start();
      await source.client.initialize(initialization);
      await other.client.initialize(initialization);
      f.gate.initialized();
      f.connection().setResponse((request) => ({
        id: request.id ?? null,
        result: {
          thread: { id: "source" },
          model: "initial-model",
          modelProvider: "source-provider",
          reasoningEffort: "high",
          serviceTier: "priority",
        },
      }));
      await source.client.request("thread/resume", { threadId: "source" });
      const updated = {
        method: "thread/settings/updated",
        params: {
          threadId: "source",
          threadSettings: settings,
        },
      };
      f.connection().emit(updated);
      await vi.waitFor(() => expect(source.output).toContainEqual(updated));
      await other.client.request("thread/fork", { threadId: "source" });
      expect(f.connection(0, 1).requests.at(-1)?.params).toEqual({
        threadId: "source",
        modelProvider: "source-provider",
        ...expected,
      });
    } finally {
      await f.owner.stop();
      source.client.close();
      other.client.close();
    }
  },
);

it("does not replace source Model settings with an invalid Fork identity", async () => {
  const f = fixture();
  const { client } = f.attach();
  try {
    await f.owner.start();
    await client.initialize(initialization);
    f.gate.initialized();
    f.connection().setResponse((request) => ({
      id: request.id ?? null,
      result: {
        thread: { id: "source" },
        model: request.method === "thread/fork" ? "invalid-child-model" : "source-model",
      },
    }));
    await client.request("thread/resume", { threadId: "source" });
    await client.request("thread/fork", { threadId: "source" });
    await client.request("thread/fork", { threadId: "source" });
    expect(f.connection().requests.at(-1)?.params).toEqual({
      threadId: "source",
      model: "source-model",
    });
  } finally {
    await f.owner.stop();
    client.close();
  }
});

it("requires current native confirmation after restart before inheriting a Fork's Model", async () => {
  const f = fixture();
  const source = f.attach();
  const other = f.attach();
  try {
    await f.owner.start();
    await source.client.initialize(initialization);
    await other.client.initialize(initialization);
    f.gate.initialized();
    f.connection().setResponse((request) => ({
      id: request.id ?? null,
      result: { thread: { id: "source" }, model: "retired-model", reasoningEffort: "high" },
    }));
    await source.client.request("thread/resume", { threadId: "source" });
    await f.owner.stop();
    await f.owner.start();
    f.gate.initialized();
    await other.client.request("thread/fork", { threadId: "source" });
    expect(f.connection(1, 1).requests.at(-1)?.params).toEqual({ threadId: "source" });
    f.connection(1).setResponse((request) => ({
      id: request.id ?? null,
      result: {
        thread: { id: request.method === "thread/fork" ? "child" : "source" },
        model: "current-model",
        reasoningEffort: "low",
      },
    }));
    await source.client.request("thread/fork", { threadId: "source", excludeTurns: true });
    expect(
      f
        .connection(1)
        .requests.slice(2)
        .map(({ method }) => method),
    ).toEqual(["thread/resume", "thread/fork"]);
    expect(f.connection(1).requests.at(-1)?.params).toEqual({
      threadId: "source",
      excludeTurns: true,
      model: "current-model",
      config: { model_reasoning_effort: "low" },
    });
  } finally {
    await f.owner.stop();
    source.client.close();
    other.client.close();
  }
});

it.each(["request", "send"] as const)(
  "keeps inherited settings out of a Fork child's recovery params through %s",
  async (transport) => {
    const f = fixture();
    const { client, output } = f.attach();
    try {
      await f.owner.start();
      await client.initialize(initialization);
      f.gate.initialized();
      f.connection().setResponse((request) => ({
        id: request.id ?? null,
        result: {
          thread: { id: request.method === "thread/fork" ? "child" : "source" },
          model: "source-model",
          reasoningEffort: "high",
        },
      }));
      await client.request("thread/resume", { threadId: "source" });
      const params = { threadId: "source", lastTurnId: "source-turn" };
      if (transport === "request") await client.request("thread/fork", params);
      else {
        await client.send({ id: "fork", method: "thread/fork", params });
        await vi.waitFor(() => expect(output.some(({ id }) => id === "fork")).toBe(true));
      }

      await f.owner.stop();
      await f.owner.start();
      f.gate.initialized();
      f.connection(1).setResponse((request) => ({
        id: request.id ?? null,
        ...(request.method === "turn/start"
          ? { result: { turn: { id: "turn", status: "inProgress" } } }
          : {
              result: {
                thread: { id: String((request.params as JsonObject).threadId) },
                model: "latest-child-model",
              },
            }),
      }));
      await client.request("turn/start", { threadId: "child", input: [] });
      const resume = f.connection(1).requests.find((request) => request.method === "thread/resume");
      expect(resume?.params).toEqual({ threadId: "child", excludeTurns: true });
    } finally {
      await f.owner.stop();
      client.close();
    }
  },
);

it("falls back to the native Fork when source settings cannot be restored", async () => {
  const f = fixture();
  const { client } = f.attach();
  try {
    await f.owner.start();
    await client.initialize(initialization);
    f.gate.initialized();
    f.connection().setResponse((request) => ({
      id: request.id ?? null,
      result: { thread: { id: "source" }, model: "retired-model" },
    }));
    await client.request("thread/resume", { threadId: "source" });

    await f.owner.stop();
    await f.owner.start();
    f.gate.initialized();
    f.connection(1).setResponse((request) => ({
      id: request.id ?? null,
      ...(request.method === "thread/resume"
        ? { error: { code: -32600, message: "Source is not available" } }
        : { result: { thread: { id: "child" }, model: "native-default" } }),
    }));
    const params = { threadId: "source", lastTurnId: "source-turn" };
    await expect(client.request("thread/fork", params)).resolves.toMatchObject({
      result: { thread: { id: "child" } },
    });
    expect(
      f
        .connection(1)
        .requests.filter(({ method }) => method === "thread/resume" || method === "thread/fork")
        .map(({ method, params: requestParams }) => ({ method, params: requestParams })),
    ).toEqual([
      {
        method: "thread/resume",
        params: { threadId: "source", excludeTurns: true },
      },
      { method: "thread/fork", params },
    ]);
  } finally {
    await f.owner.stop();
    client.close();
  }
});

it("leaves explicit and alternate-source Forks alone after a native restart", async () => {
  const f = fixture();
  const { client } = f.attach();
  try {
    await f.owner.start();
    await client.initialize(initialization);
    f.gate.initialized();
    await client.request("thread/resume", { threadId: "source" });
    await f.owner.stop();
    await f.owner.start();
    f.gate.initialized();
    f.connection(1).setResponse((request) => ({
      id: request.id ?? null,
      ...(request.method === "thread/resume"
        ? { error: { code: -32600, message: "Source is not available" } }
        : { result: { thread: { id: "child" } } }),
    }));
    for (const overrides of [
      { model: "explicit-model" },
      { path: "/alternate-source.jsonl" },
      { history: [] },
    ]) {
      const params = { threadId: "source", ...overrides };
      await expect(client.request("thread/fork", params)).resolves.toMatchObject({
        result: { thread: { id: "child" } },
      });
      expect(f.connection(1).requests.at(-1)?.params).toEqual(params);
    }
    expect(f.connection(1).requests.some(({ method }) => method === "thread/resume")).toBe(false);
  } finally {
    await f.owner.stop();
    client.close();
  }
});

it("projects resolution IDs per client and retires another client's answered request", async () => {
  const f = fixture();
  const a = f.attach(),
    b = f.attach();
  try {
    await f.owner.start();
    await a.client.initialize(initialization);
    await b.client.initialize(initialization);
    f.gate.initialized();
    const request = {
      id: 17,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-one" },
    };
    f.connection(0, 0).emit(request);
    f.connection(0, 1).emit(request);
    await vi.waitFor(() =>
      expect(b.output.some((message) => message.method === request.method)).toBe(true),
    );
    const aId = a.output.find((message) => message.method === request.method)?.id;
    const bId = b.output.find((message) => message.method === request.method)?.id;
    if (typeof aId !== "string" || typeof bId !== "string")
      throw new Error("Missing projected request");
    expect(aId).not.toBe(bId);
    await a.client.send({ id: aId, result: { decision: "accept" } });
    f.connection(0, 1).emit({ method: "serverRequest/resolved", params: { requestId: 17 } });
    await vi.waitFor(() =>
      expect(b.output).toContainEqual({
        method: "serverRequest/resolved",
        params: { requestId: bId },
      }),
    );
    await expect(b.client.send({ id: bId, result: { decision: "accept" } })).rejects.toThrow(
      "Retired",
    );
  } finally {
    await f.owner.stop();
    a.client.close();
    b.client.close();
  }
});

it("does not treat resumed historical inProgress Turns as active work on this backend", async () => {
  const f = fixture();
  const { client } = f.attach();
  try {
    await f.owner.start();
    await client.initialize(initialization);
    f.gate.initialized();
    f.connection().setResponse((request) => ({
      id: request.id ?? null,
      result:
        request.method === "thread/resume"
          ? { thread: { id: "thread-one", turns: [{ id: "stale-turn", status: "inProgress" }] } }
          : { turn: { id: "new-turn", status: "inProgress" } },
    }));
    await client.request("thread/resume", { threadId: "thread-one" });
    expect(f.owner.hasActiveWork).toBe(false);
    await client.request("turn/start", { threadId: "thread-one", input: [] });
    expect(f.owner.hasActiveWork).toBe(true);
    f.connection().emit({ method: "turn/completed", params: { threadId: "thread-one" } });
    await vi.waitFor(() => expect(f.owner.hasActiveWork).toBe(false));
  } finally {
    await f.owner.stop();
    client.close();
  }
});

describe("owned loopback backend", () => {
  it("requires readiness, hashes capability authentication, and discards managed stderr", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
        return true;
      }),
    });
    const spawnOfficial = vi.fn(() => child as unknown as ChildProcess) as unknown as typeof spawn;
    const backend = createOwnedLoopbackBackend({
      stockCodexPath: "/synthetic/codex",
      arguments: ["app-server"],
      environment: { CODEX_HOME: "/synthetic/home" },
      spawnOfficial,
    });
    const stderr = vi.spyOn(process.stderr, "write");
    try {
      await expect(backend.connect()).rejects.toThrow("not ready");
      const starting = backend.start();
      child.stderr.write("synthetic credential-bearing failure\n");
      child.stderr.write("listening on: ws://127.0.0.1:43821\n");
      await starting;
      expect(stderr).not.toHaveBeenCalled();
      expect(spawnOfficial).toHaveBeenCalledWith(
        "/synthetic/codex",
        [
          "app-server",
          "--listen",
          "ws://127.0.0.1:0",
          "--ws-auth",
          "capability-token",
          "--ws-token-sha256",
          expect.stringMatching(/^[a-f0-9]{64}$/),
        ],
        expect.objectContaining({ env: { CODEX_HOME: "/synthetic/home" } }),
      );
      expect(backend.processId).toBe(123);
      await backend.stop();
      await expect(backend.closed).resolves.toEqual({ code: null, signal: "SIGTERM" });
      await expect(backend.connect()).rejects.toThrow("not ready");
    } finally {
      stderr.mockRestore();
      await backend.stop();
    }
  });
});

describe("single official runtime owner", () => {
  it.each([
    { via: "request", method: "account/rateLimits/read" },
    { via: "request", method: "thread/read" },
    { via: "send", method: "account/rateLimits/read" },
    { via: "send", method: "account/read" },
  ])(
    "ends pending $via $method on intentional stop and admits work after restart",
    async ({ via, method }) => {
      const f = fixture();
      const { client, output } = f.attach();
      try {
        await f.owner.start();
        await client.initialize(initialization);
        f.gate.initialized();
        const connection = f.connection();
        connection.setResponse(() => null);
        const pending = (
          via === "request"
            ? client.request(method, {})
            : client.send({ id: "desktop-request", method, params: {} })
        ).catch((error: unknown) => error);
        await vi.waitFor(() =>
          expect(connection.requests.some((r) => r.method === method)).toBe(true),
        );
        f.gate.unavailable();
        await expect(client.request(method, {})).rejects.toMatchObject({ code: "unavailable" });
        await f.owner.stop();
        if (via === "request") expect(await pending).toBeInstanceOf(Error);
        else {
          await pending;
          expect(output).toContainEqual(
            expect.objectContaining({ id: "desktop-request", error: expect.any(Object) }),
          );
        }
        expect(f.gate.phase).toBe("unavailable");
        expect(f.gate.busy).toBe(false);
        expect(f.create).toHaveBeenCalledOnce();
        await expect(client.request(method, {})).rejects.toMatchObject({ code: "unavailable" });
        expect(f.create).toHaveBeenCalledOnce();
        await f.owner.start();
        f.gate.initialized();
        await client.request("account/rateLimits/read", {});
        expect(f.connection(1).requests.filter((r) => r.method === method)).toHaveLength(
          method === "account/rateLimits/read" ? 1 : 0,
        );
      } finally {
        await f.owner.stop();
        client.close();
      }
    },
  );

  it("fails a local quota timeout without making the owned backend unavailable", async () => {
    const f = fixture();
    const { client } = f.attach();
    try {
      await f.owner.start();
      await client.initialize(initialization);
      f.gate.initialized();
      f.connection().setResponse(() => null);
      vi.useFakeTimers();
      const quota = client.request("account/rateLimits/read", {}).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(29_950);
      await vi.advanceTimersByTimeAsync(100);
      expect(await quota).toBeInstanceOf(Error);
      expect(f.gate.busy).toBe(false);
      expect(f.gate.phase).toBe("ready");
      expect(f.owner.running).toBe(true);
      f.connection().setResponse((request) => ({ id: request.id ?? null, result: {} }));
      await client.request("model/list", {});
      // A timed-out request is not exit proof, even though admission stays ready.
      f.native().failStop(true);
      await expect(f.owner.stop()).rejects.toThrow("unavailable");
      await expect(f.owner.start()).rejects.toThrow("unavailable");
      f.native().failStop(false);
    } finally {
      vi.useRealTimers();
      await f.owner.stop();
      client.close();
    }
  });

  it("fails detached quota requests without disrupting other clients", async () => {
    const f = fixture();
    const { client, output } = f.attach();
    try {
      await f.owner.start();
      await client.initialize(initialization);
      f.gate.initialized();
      f.connection().setResponse(() => null);
      await client.send({ id: "quota", method: "account/rateLimits/read", params: {} });
      client.close();
      expect(output).toContainEqual({
        id: "quota",
        error: { code: -32001, message: "Official connection retired; retry explicitly" },
      });
      expect(f.gate.busy).toBe(false);
      expect(f.gate.phase).toBe("ready");
      const other = f.attach();
      await other.client.initialize(initialization);
      await other.client.request("model/list", {});
      expect(f.create).toHaveBeenCalledOnce();
    } finally {
      await f.owner.stop();
      client.close();
    }
  });

  it("forwards native activity without probing queues or blocking metadata admission", async () => {
    const f = fixture();
    const { client, output } = f.attach();
    try {
      await f.owner.start();
      await client.initialize(initialization);
      f.gate.initialized();
      for (const method of ["turn/start", "thread/queue/add", "thread/goal/set", "process/spawn"])
        await client.request(method, { threadId: "active", processHandle: "tool" });
      const notifications = [
        { method: "turn/started", params: { threadId: "active", turn: { id: "turn" } } },
        {
          method: "thread/status/changed",
          params: { threadId: "active", status: { type: "active" } },
        },
        { method: "thread/queue/changed", params: { threadId: "active" } },
        {
          method: "thread/goal/updated",
          params: { threadId: "active", goal: { status: "active" } },
        },
      ];
      for (const notification of notifications) f.connection().emit(notification);
      await vi.waitFor(() => expect(output).toEqual(notifications));
      expect(f.connection().requests.map(({ method }) => method)).toEqual([
        "initialize",
        "initialized",
        "turn/start",
        "thread/queue/add",
        "thread/goal/set",
        "process/spawn",
      ]);
      expect(f.gate.busy).toBe(false);
      expect(f.owner.running).toBe(true);
      await f.owner.stop();
      await f.owner.start();
      f.gate.initialized();
      expect(f.peak()).toBe(1);
    } finally {
      await f.owner.stop();
    }
  });

  it("still makes actual quota transport loss unavailable", async () => {
    const f = fixture();
    const { client } = f.attach();
    try {
      await f.owner.start();
      await client.initialize(initialization);
      f.gate.initialized();
      f.connection().setResponse(() => null);
      const quota = client.request("account/rateLimits/read", {}).catch((error: unknown) => error);
      await vi.waitFor(() =>
        expect(
          f.connection().requests.some((request) => request.method === "account/rateLimits/read"),
        ).toBe(true),
      );
      f.connection().stdout.end();
      expect(await quota).toBeInstanceOf(Error);
      await vi.waitFor(() => expect(f.gate.phase).toBe("unavailable"));
      await expect(client.request("model/list", {})).rejects.toThrow("unavailable");
      await expect(f.owner.start()).rejects.toThrow("unavailable");
    } finally {
      await f.owner.stop();
    }
  });

  it("releases admission when a native RPC completes", async () => {
    const f = fixture();
    const { client } = f.attach();
    try {
      await f.owner.start();
      await client.initialize(initialization);
      f.gate.initialized();
      f.connection().setResponse(() => null);
      const result = client.request("model/list", {});
      await vi.waitFor(() =>
        expect(f.connection().requests.some((request) => request.method === "model/list")).toBe(
          true,
        ),
      );
      const request = f.connection().requests.find((request) => request.method === "model/list");
      if (!request) throw new Error("Missing synthetic native request");
      expect(f.gate.busy).toBe(true);
      f.connection().stdout.write(`${JSON.stringify({ id: request.id, result: { data: [] } })}\n`);
      await expect(result).resolves.toMatchObject({ result: { data: [] } });
      expect(f.gate.busy).toBe(false);
      expect(f.gate.phase).toBe("ready");
    } finally {
      await f.owner.stop();
      client.close();
    }
  });

  it("tracks pending official credential reads as ordinary requests", async () => {
    const f = fixture();
    const { client } = f.attach();
    try {
      await f.owner.start();
      await client.initialize(initialization);
      f.gate.initialized();
      f.connection().setResponse(() => null);
      await client.send({ id: "auth", method: "account/read", params: { refreshToken: true } });
      expect(f.gate.busy).toBe(true);
      expect(f.gate.phase).toBe("ready");
    } finally {
      await f.owner.stop();
      client.close();
    }
  });

  it("notifies attached clients once per proved retirement, never on failed stop or client detach", async () => {
    const f = fixture();
    const retired = vi.fn();
    const detachedRetired = vi.fn();
    const brokenObserver = f.owner.attach(
      async () => {},
      () => {
        throw new Error("synthetic observer");
      },
    );
    const client = f.owner.attach(async () => {}, retired);
    const detached = f.owner.attach(async () => {}, detachedRetired);
    try {
      await f.owner.start();
      detached.close();
      f.native().failStop(true);
      f.native().closeUnexpectedly();
      await expect(f.owner.stop()).rejects.toThrow("unavailable");
      expect(retired).not.toHaveBeenCalled();
      expect(detachedRetired).not.toHaveBeenCalled();
      f.native().failStop(false);
      await f.owner.stop();
      expect(retired).toHaveBeenCalledOnce();
      await f.owner.stop();
      expect(retired).toHaveBeenCalledOnce();
      await f.owner.start();
      await f.owner.stop();
      expect(retired).toHaveBeenCalledTimes(2);
      expect(detachedRetired).not.toHaveBeenCalled();
      expect(f.peak()).toBe(1);
    } finally {
      f.native().failStop(false);
      await f.owner.stop();
      client.close();
      detached.close();
      brokenObserver.close();
    }
  });

  it("connects management first and initializes every attached client once", async () => {
    const f = fixture();
    const task = f.attach();
    task.client.configure(initialization);
    const management = f.owner.attachManagement(async () => {});
    const managementParams = { clientInfo: { name: "management", version: "1" } };
    management.configure(managementParams);
    await f.owner.start();
    expect(f.native().connections).toHaveLength(2);
    expect(f.connection().requests[0]?.params).toEqual(managementParams);
    expect(f.connection(0, 1).requests[0]?.params).toEqual(initialization);
    expect(f.connection().requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
    ]);
    await Promise.all([
      management.initialize(managementParams),
      management.initialize(managementParams),
    ]);
    expect(f.connection().requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
    ]);
    await f.owner.stop();
    await f.owner.start();
    expect(f.native(1).connections).toHaveLength(2);
    await f.owner.stop();
  });

  it.each(["request", "send"] as const)(
    "forwards native auth through %s without retaining a login lease",
    async (transport) => {
      const f = fixture();
      const { client, output } = f.attach();
      try {
        await f.owner.start();
        f.gate.initialized();
        f.connection().setResponse((request) => ({
          id: request.id ?? null,
          result: { type: "chatgpt", loginId: "native-id", futureField: true },
        }));
        const params = { type: "chatgpt", futureField: true };
        if (transport === "request") {
          await expect(client.request("account/login/start", params)).resolves.toMatchObject({
            result: { loginId: "native-id", futureField: true },
          });
        } else {
          await client.send({ id: 77, method: "account/login/start", params });
          await vi.waitFor(() =>
            expect(output).toContainEqual({
              id: 77,
              result: { type: "chatgpt", loginId: "native-id", futureField: true },
            }),
          );
        }
        expect(f.connection().requests[0]?.params).toEqual(params);
        expect(f.gate.busy).toBe(false);
        expect(f.gate.phase).toBe("ready");
        const completed = {
          method: "account/login/completed",
          params: { loginId: "native-id", success: true, futureField: true },
        };
        f.connection().emit(completed);
        await vi.waitFor(() => expect(output).toContainEqual(completed));
        expect(f.gate.busy).toBe(false);
      } finally {
        await f.owner.stop();
      }
    },
  );

  it("does not retain native login activity after its response or client detach", async () => {
    const f = fixture();
    const { client } = f.attach();
    await f.owner.start();
    f.gate.initialized();
    f.connection().setResponse((request) => ({
      id: request.id ?? null,
      result: { loginId: "native-id" },
    }));
    await client.request("account/login/start", {});
    client.close();
    expect(f.gate.busy).toBe(false);
    await f.owner.stop();
    expect(f.gate.busy).toBe(false);
  });

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
      await f.owner.stop();
      await f.owner.start();
      f.gate.initialized();
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
      await f.owner.stop();
      await f.owner.start();
      f.gate.initialized();
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
      expect(f.gate.busy).toBe(false);
      f.connection(1).emit({
        method: "turn/completed",
        params: { threadId: "original", turn: { id: "turn-one", status: "completed" } },
      });
      await vi.waitFor(() =>
        expect(a.output).toContainEqual({
          method: "turn/completed",
          params: { threadId: "original", turn: { id: "turn-one", status: "completed" } },
        }),
      );
    } finally {
      await f.owner.stop();
    }
  });

  it.each([false, true])(
    "lazily rejoins the same Thread with subscription parameters (dormant generation: %s)",
    async (dormant) => {
      const f = fixture();
      const a = f.attach();
      try {
        await f.owner.start();
        await a.client.initialize(initialization);
        f.gate.initialized();
        await a.client.request("thread/resume", {
          threadId: "settings-thread",
          model: "initial-model",
          modelProvider: "initial-provider",
          serviceTier: null,
          cwd: "/initial/cwd",
          runtimeWorkspaceRoots: ["/initial/cwd"],
          approvalPolicy: "never",
          approvalsReviewer: "auto_review",
          sandbox: "danger-full-access",
        });

        await f.owner.stop();
        await f.owner.start();
        f.gate.initialized();
        let generation = 1;
        if (dormant) {
          // A generation with no user requests must still preserve subscription parameters.
          await f.owner.stop();
          await f.owner.start();
          f.gate.initialized();
          generation++;
        }
        f.connection(generation).setResponse((request) => {
          if (!request.method) return null;
          if (request.method === "thread/resume")
            return { id: request.id ?? null, result: { thread: { id: "settings-thread" } } };
          if (request.method === "turn/interrupt") return { id: request.id ?? null, result: {} };
          return { id: request.id ?? null, result: {} };
        });

        await a.client.request("turn/interrupt", {
          threadId: "settings-thread",
          turnId: "old-turn",
        });
        expect(
          f
            .connection(generation)
            .requests.slice(2)
            .map(({ method, params }) => ({ method, params })),
        ).toEqual([
          {
            method: "thread/resume",
            params: {
              threadId: "settings-thread",
              model: "initial-model",
              modelProvider: "initial-provider",
              serviceTier: null,
              cwd: "/initial/cwd",
              runtimeWorkspaceRoots: ["/initial/cwd"],
              approvalPolicy: "never",
              approvalsReviewer: "auto_review",
              sandbox: "danger-full-access",
              excludeTurns: true,
            },
          },
          {
            method: "turn/interrupt",
            params: { threadId: "settings-thread", turnId: "old-turn" },
          },
        ]);

        await f.owner.stop();
        await f.owner.start();
        f.gate.initialized();
        f.connection(generation + 1).setResponse((request) => {
          if (!request.method) return null;
          if (request.method === "thread/resume")
            return { id: request.id ?? null, error: { code: -32600, message: "cannot resume" } };
          return { id: request.id ?? null, result: {} };
        });
        await expect(
          a.client.request("turn/interrupt", {
            threadId: "settings-thread",
            turnId: "must-not-forward",
          }),
        ).rejects.toThrow("Thread restoration failed");
        expect(f.connection(generation + 1).requests).not.toContainEqual(
          expect.objectContaining({
            method: "turn/interrupt",
            params: expect.objectContaining({ turnId: "must-not-forward" }),
          }),
        );
      } finally {
        await f.owner.stop();
      }
    },
  );

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
      await f.owner.stop();
      await f.owner.start();
      f.gate.initialized();
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
      await f.owner.stop();
      await f.owner.start();
      f.gate.initialized();
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

  it("keeps ownership when an unexpected close cannot prove tree exit", async () => {
    const f = fixture();
    const client = f.attach();
    await f.owner.start();
    await client.client.initialize(initialization);
    f.gate.initialized();
    await client.client.request("process/spawn", { processHandle: "live-process" });
    expect(f.gate.busy).toBe(false);

    f.native().failStop(true);
    f.native().closeUnexpectedly();
    await vi.waitFor(() => expect(f.gate.phase).toBe("unavailable"));
    await expect(f.owner.stop()).rejects.toThrow("unavailable");

    expect(f.gate.phase).toBe("unavailable");
    await expect(f.owner.start()).rejects.toThrow("unavailable");
    expect(f.create).toHaveBeenCalledOnce();

    f.native().failStop(false);
    await f.owner.stop();
    expect(f.gate.busy).toBe(false);
  });

  it("requires initialization after restarting an unexpectedly exited backend", async () => {
    const f = fixture();
    const client = f.attach();
    await f.owner.start();
    await client.client.initialize(initialization);
    f.gate.initialized();
    await client.client.request("process/spawn", { processHandle: "exited-process" });
    expect(f.gate.busy).toBe(false);

    f.native().closeUnexpectedly();
    await vi.waitFor(() => expect(f.owner.running).toBe(false));
    await f.owner.stop();
    expect(f.gate.phase).toBe("unavailable");
    expect(f.create).toHaveBeenCalledOnce();

    await f.owner.start();
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.gate.phase).toBe("unavailable");
    f.gate.initialized();
    await f.owner.stop();
  });

  it("reports server reply send failures without introducing a work lease", async () => {
    const f = fixture();
    const a = f.attach();
    try {
      await f.owner.start();
      await a.client.initialize(initialization);
      f.gate.initialized();
      f.connection().emit({
        id: 7,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-one" },
      });
      await vi.waitFor(() => expect(a.output).toHaveLength(1));
      const id = a.output[0]?.id;
      if (typeof id !== "string") throw new Error("Missing projected server ID");
      f.connection().stdin.destroy(new Error("synthetic reply send failure"));
      await expect(a.client.send({ id, result: {} })).rejects.toThrow(
        "synthetic reply send failure",
      );
      expect(f.gate.busy).toBe(false);
    } finally {
      await f.owner.stop().catch(() => undefined);
    }
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
