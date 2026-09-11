import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import {
  OfficialRuntimeOwner,
  type OwnedOfficialBackend,
} from "../src/codex-runtime/official-runtime-owner.js";
import { OfficialRuntimeScope } from "../src/codex-runtime/official-runtime-scope.js";
import { OfficialWorkGate } from "../src/codex-runtime/official-work-gate.js";
import type { OfficialAppServerExit } from "../src/official-app-server-connection.js";

function fixture(allowNativeAuthPassthrough = false) {
  let live = 0;
  let peak = 0;
  const events: string[] = [];
  const roles: unknown[] = [];
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
  const create = vi.fn((role: unknown) => {
    roles.push(role);
    const value = backend();
    backends.push(value);
    return value.native;
  });
  const owner = new OfficialRuntimeOwner({
    createBackend: create,
    diagnosticOutput: new PassThrough(),
    gate,
    permanentHome: "/permanent",
    allowNativeAuthPassthrough,
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
  return { owner, gate, create, attach, native, connection, events, roles, peak: () => peak };
}
const initialization = {
  clientInfo: { name: "synthetic", version: "1" },
  capabilities: { experimentalApi: true },
};

describe("single official runtime owner", () => {
  it("does not create or publish a backend from managed scope startup", async () => {
    const closed = Promise.withResolvers<OfficialAppServerExit>();
    const createBackend = vi.fn((): OwnedOfficialBackend => ({
      closed: closed.promise,
      start: vi.fn(async () => {}),
      connect: vi.fn(async () => {
        throw new Error("must not connect");
      }),
      stop: vi.fn(async () => closed.resolve({ code: 0, signal: null })),
    }));
    const scope = new OfficialRuntimeScope({
      createBackend,
      diagnosticOutput: new PassThrough(),
      permanentHome: "/permanent",
      managedAccounts: true,
    });

    await expect(scope.start()).rejects.toMatchObject({ code: "unavailable" });
    expect(createBackend).not.toHaveBeenCalled();
    expect(scope.owner.running).toBe(false);
    expect(scope.gate.phase).toBe("unavailable");

    await scope.owner.start({ mode: "management-only" });
    scope.gate.initialized();
    await expect(scope.start()).resolves.toBeUndefined();
    expect(createBackend).toHaveBeenCalledOnce();
    await scope.owner.stop();
    await expect(scope.start()).rejects.toMatchObject({ code: "unavailable" });
    expect(createBackend).toHaveBeenCalledOnce();
    await scope.close();
  });

  it("starts staging with only the persistent management client and initializes it once", async () => {
    const f = fixture();
    const task = f.attach();
    task.client.configure(initialization);
    const management = f.owner.attachManagement(async () => {});
    management.configure(initialization);
    await f.owner.start({ homeOverride: "/staging", mode: "management-only" });
    expect(f.roles).toEqual([{ kind: "staging", home: "/staging" }]);
    expect(f.native().connections).toHaveLength(1);
    expect(f.connection().requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
    ]);
    await Promise.all([
      management.initialize(initialization),
      management.initialize(initialization),
    ]);
    expect(f.connection().requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
    ]);
    await f.owner.stop();
    await f.owner.start();
    expect(f.roles).toEqual([
      { kind: "staging", home: "/staging" },
      { kind: "permanent", home: "/permanent" },
    ]);
    expect(f.native(1).connections).toHaveLength(2);
    await f.owner.stop();
  });

  it("allows native authentication only for an explicitly unmanaged owner", async () => {
    const managed = fixture();
    const managedClient = managed.attach();
    await managed.owner.start();
    managed.gate.initialized();
    await expect(managedClient.client.request("account/logout", {})).rejects.toThrow(
      "Host coordinator",
    );
    await managed.owner.stop();

    const unmanaged = fixture(true);
    const unmanagedClient = unmanaged.attach();
    await unmanaged.owner.start();
    unmanaged.gate.initialized();
    await expect(unmanagedClient.client.request("account/logout", {})).resolves.toMatchObject({
      result: {},
    });
    await unmanaged.owner.stop();
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

  it.each([false, true])(
    "restores effective settings across replacements (dormant generation: %s)",
    async (dormant) => {
      const f = fixture();
      const a = f.attach();
      const effective = {
        thread: {
          id: "settings-thread",
          status: { type: "idle" },
          model: "latest-model",
          modelProvider: "latest-provider",
          reasoningEffort: "high",
        },
        model: "latest-model",
        modelProvider: "latest-provider",
        serviceTier: "priority",
        cwd: "/latest/cwd",
        runtimeWorkspaceRoots: ["/latest/cwd", "/latest/shared"],
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
        activePermissionProfile: { id: ":read-only", extends: null },
        reasoningEffort: "high",
        multiAgentMode: "explicitRequestOnly",
        initialTurnsPage: null,
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
      };
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

        const change = f.gate.beginChange();
        f.owner.captureThreadSettings([effective]);
        await f.owner.stop();
        await f.owner.start();
        change.finish("ready");
        let generation = 1;
        if (dormant) {
          // B had no user requests, so its loaded list is empty before switching back to A.
          const back = f.gate.beginChange();
          f.owner.captureThreadSettings([]);
          await f.owner.stop();
          await f.owner.start();
          back.finish("ready");
          generation++;
        }
        f.connection(generation).setResponse((request) => {
          if (!request.method) return null;
          if (request.method === "thread/resume")
            return { id: request.id ?? null, result: effective };
          if (request.method === "thread/settings/update")
            return { id: request.id ?? null, result: {} };
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
              model: "latest-model",
              modelProvider: "latest-provider",
              serviceTier: "priority",
              cwd: "/latest/cwd",
              runtimeWorkspaceRoots: ["/latest/cwd", "/latest/shared"],
              approvalPolicy: "on-request",
              approvalsReviewer: "user",
              permissions: ":read-only",
              excludeTurns: true,
            },
          },
          {
            method: "thread/settings/update",
            params: { threadId: "settings-thread", effort: "high" },
          },
          {
            method: "thread/resume",
            params: { threadId: "settings-thread", excludeTurns: true },
          },
          {
            method: "turn/interrupt",
            params: { threadId: "settings-thread", turnId: "old-turn" },
          },
        ]);

        const secondChange = f.gate.beginChange();
        await f.owner.stop();
        await f.owner.start();
        secondChange.finish("ready");
        f.connection(generation + 1).setResponse((request) => {
          if (!request.method) return null;
          if (request.method === "thread/resume")
            return {
              id: request.id ?? null,
              result: {
                ...effective,
                activePermissionProfile: { id: ":read-only", extends: ":changed-base" },
              },
            };
          return { id: request.id ?? null, result: {} };
        });
        await expect(
          a.client.request("turn/interrupt", {
            threadId: "settings-thread",
            turnId: "must-not-forward",
          }),
        ).rejects.toThrow("settings restoration failed");
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

  it("retains native work when an unexpected close cannot prove tree exit", async () => {
    const f = fixture();
    const client = f.attach();
    await f.owner.start();
    await client.client.initialize(initialization);
    f.gate.initialized();
    await client.client.request("process/spawn", { processHandle: "live-process" });
    expect(f.gate.busy).toBe(true);

    f.native().failStop(true);
    f.native().closeUnexpectedly();
    await vi.waitFor(() => expect(f.gate.phase).toBe("unavailable"));
    await expect(f.owner.stop()).rejects.toThrow("unavailable");

    expect(f.gate.busy).toBe(true);
    await expect(f.owner.start()).rejects.toThrow("unavailable");
    expect(f.create).toHaveBeenCalledOnce();

    f.native().failStop(false);
    await f.owner.stop();
    expect(f.gate.busy).toBe(false);
  });

  it("retires work only after proving an unexpected tree exit and requires explicit recovery", async () => {
    const f = fixture();
    const client = f.attach();
    await f.owner.start();
    await client.client.initialize(initialization);
    f.gate.initialized();
    await client.client.request("process/spawn", { processHandle: "exited-process" });
    expect(f.gate.busy).toBe(true);

    f.native().closeUnexpectedly();
    await vi.waitFor(() => expect(f.owner.running).toBe(false));
    await vi.waitFor(() => expect(f.gate.busy).toBe(false));
    expect(f.gate.phase).toBe("unavailable");
    expect(f.create).toHaveBeenCalledOnce();

    await f.owner.start();
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.gate.phase).toBe("unavailable");
    f.gate.initialized();
    await f.owner.stop();
  });

  it("clears native work when sending a server reply fails", async () => {
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
      const change = f.gate.beginChange();
      change.finish("ready");
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
