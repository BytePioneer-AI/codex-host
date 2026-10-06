import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import {
  harnessIdSchema,
  encodeHarnessPluginRoute,
  harnessModelRefSchema,
} from "@codexhost/shared-contracts";
import { decodeCreateRoute, type JsonObject } from "@codexhost/protocol-core";
import { startLocalSharedHost, localSharedHostSocket } from "../src/local-shared-host.js";
import { createFrontendInitializationGate } from "../src/frontend-initialization-gate.js";
import { JsonLineCollector } from "./app-server-host-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function streams() {
  return {
    input: new PassThrough(),
    output: new PassThrough(),
    diagnosticOutput: new PassThrough(),
  };
}

describe("local shared Host frontend", () => {
  it("does not enable the alternate lifecycle without an explicit private endpoint", () => {
    expect(localSharedHostSocket({})).toBeUndefined();
    expect(() =>
      localSharedHostSocket({ CODEXHOST_REMOTE_HOST_SOCKET: "relative.sock" }),
    ).toThrow();
  });

  it("releases announcements only after a successful matching initialize response", async () => {
    const io = streams();
    const failure = vi.fn();
    const gate = createFrontendInitializationGate(io, failure);
    cleanup.push(async () => gate.close());
    const output = new JsonLineCollector(io.output);
    gate.input.resume();
    io.input.write('{"id":1,"method":"initialize","params":{}}\n');
    gate.output.write('{"method":"thread/started","params":{}}\n');
    gate.output.write('{"id":2,"result":{}}\n');
    gate.output.write('{"id":1,"error":{"code":-1,"message":"retry"}}\n');
    expect(output.messages.map((m) => m.id)).toEqual([2, 1]);
    io.input.write('{"id":3,"method":"initialize","params":{}}\n');
    gate.output.write('{"id":3,"result":{}}\n');
    expect(output.messages.map((m) => m.id ?? m.method)).toEqual([2, 1, 3, "thread/started"]);
    expect(failure).not.toHaveBeenCalled();
    gate.close();
    expect(io.output.destroyed).toBe(false);
  });

  it("accepts the first successful initialize when requests are pipelined", () => {
    const io = streams();
    const gate = createFrontendInitializationGate(io, vi.fn());
    cleanup.push(async () => gate.close());
    const output = new JsonLineCollector(io.output);
    gate.input.resume();
    io.input.write('{"id":1,"method":"initialize"}\n{"id":2,"method":"initialize"}\n');
    gate.output.write('{"method":"thread/started","params":{}}\n');
    gate.output.write('{"id":1,"result":{}}\n');
    expect(output.messages.map((m) => m.id ?? m.method)).toEqual([1, "thread/started"]);
  });

  it("handles frontend transport errors and releases listeners when closed", () => {
    const io = streams();
    const failure = vi.fn();
    const gate = createFrontendInitializationGate(io, failure);
    const error = new Error("transport disconnected");
    io.input.emit("error", error);
    io.output.emit("error", error);
    expect(failure).toHaveBeenCalledTimes(2);
    gate.close();
    expect(io.input.listenerCount("error")).toBe(0);
    expect(io.output.listenerCount("error")).toBe(0);
  });

  it("preserves large history responses accepted by the official remote transport", () => {
    const io = streams();
    const failure = vi.fn();
    const gate = createFrontendInitializationGate(io, failure);
    cleanup.push(async () => gate.close());
    gate.input.resume();
    io.output.resume();
    io.input.write('{"id":1,"method":"initialize"}\n');
    gate.output.write('{"id":1,"result":{}}\n');
    gate.output.write(
      `${JSON.stringify({ id: 2, result: { image: "x".repeat(9 * 1024 * 1024) } })}\n`,
    );
    expect(failure).not.toHaveBeenCalled();
  });

  it("reports an initialization queue overflow without an unhandled stream error", async () => {
    const io = streams();
    const failure = vi.fn();
    const gate = createFrontendInitializationGate(io, failure);
    cleanup.push(async () => gate.close());
    gate.output.write(
      `${JSON.stringify({ method: "thread/started", params: { data: "x".repeat(1024 * 1024) } })}\n`,
    );
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    expect(failure.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it.skipIf(process.platform === "win32")(
    "shares one owner across Desktop, mobile and reconnect without reopening the native session",
    async () => {
      const directory = await mkdtemp("/tmp/ch-local-shared-");
      cleanup.push(async () => {
        await rm(directory, { recursive: true, force: true });
      });
      const store = new MappingStore({ directory: path.join(directory, "store") });
      const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
      const open = vi.spyOn(adapter, "open");
      const native = vi.fn(() => {
        throw new Error("No native process allowed in this test");
      });
      const local = await startLocalSharedHost({
        socketPath: path.join(directory, "mobile.sock"),
        common: {
          stockCodexPath: "/unused",
          arguments: [],
          externalOnly: true,
          environment: {
            HOME: directory,
            CODEX_HOME: path.join(directory, "codex"),
            CODEXHOST_DATA_DIR: directory,
          },
          mappingStore: store,
          externalAdapters: new Map([["pi", adapter]]),
          createOfficialConnection: native,
          diagnosticOutput: new PassThrough(),
        },
      });
      cleanup.push(() => local.close());
      function front(name: string) {
        const io = streams();
        const output = new JsonLineCollector(io.output);
        const frontend = local.createFrontend(io, name.startsWith("mobile"));
        const running = frontend.run();
        const request = async (id: number, method: string, params: JsonObject = {}) => {
          io.input.write(`${JSON.stringify({ id, method, params })}\n`);
          return output.waitFor((m) => m.id === id);
        };
        const initialize = () =>
          request(1, "initialize", {
            clientInfo: { name, version: "1" },
            capabilities: { experimentalApi: true },
          });
        return { io, output, frontend, running, request, initialize };
      }
      const desktop = front("desktop");
      await desktop.initialize();
      const start = await desktop.request(2, "thread/start", {
        model: encodeHarnessPluginRoute({
          harnessId: harnessIdSchema.parse("pi"),
        }),
        cwd: directory,
      });
      expect(start).not.toHaveProperty("error");
      const threadId = ((start.result as JsonObject).thread as JsonObject).id;
      if (typeof threadId !== "string") throw new Error("Expected thread ID");
      const mobile = front("mobile");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mobile.output.messages).toEqual([]);
      await mobile.initialize();
      expect(mobile.output.messages[0]?.id).toBe(1);
      expect(
        await mobile.request(2, "thread/read", { threadId, includeTurns: true }),
      ).not.toHaveProperty("error");
      const badConfig = await mobile.request(20, "config/batchWrite", {
        edits: [
          { keyPath: "model", value: "native", mergeStrategy: "replace" },
          { keyPath: "sandbox_mode", value: "read-only", mergeStrategy: "replace" },
        ],
      });
      expect(badConfig).toMatchObject({
        error: { code: -32090, message: expect.stringContaining("separately") },
      });
      const badCreate = await mobile.request(21, "thread/start", {
        model: "codexhost/pi-native",
        serviceTier: "flex",
        cwd: directory,
      });
      expect(badCreate).toMatchObject({
        error: { code: -32090, message: expect.stringContaining("service tiers") },
      });
      const turn = await desktop.request(3, "turn/start", {
        threadId,
        input: [{ type: "text", text: "synthetic" }],
      });
      expect(turn).not.toHaveProperty("error");
      await mobile.output.waitFor((m) => m.method === "turn/started");
      desktop.frontend.disconnect();
      await desktop.running;
      expect(adapter.sessions).toHaveLength(1);
      const session = adapter.sessions[0];
      if (!session) throw new Error("Expected shared session");
      session.appendText("output after Desktop disconnected");
      session.succeedTurn();
      await mobile.output.waitFor((m) => m.method === "turn/completed");
      mobile.frontend.disconnect();
      await mobile.running;
      const reconnect = front("mobile-reconnect");
      await reconnect.initialize();
      const resumed = await reconnect.request(2, "thread/resume", { threadId });
      expect(resumed).not.toHaveProperty("error");
      expect((resumed.result as JsonObject).model).toBe(
        encodeHarnessPluginRoute({
          harnessId: harnessIdSchema.parse("pi"),
          model: harnessModelRefSchema.parse({ id: "fake-model-v1.primary" }),
        }),
      );
      expect(JSON.stringify(resumed)).toContain("output after Desktop disconnected");
      const selectedModel = encodeHarnessPluginRoute({
        harnessId: harnessIdSchema.parse("pi"),
        model: harnessModelRefSchema.parse({ id: "fake-model-v1.secondary" }),
      });
      const changed = await reconnect.request(3, "turn/start", {
        threadId,
        model: selectedModel,
        input: [{ type: "text", text: "use secondary" }],
      });
      expect(changed).not.toHaveProperty("error");
      const inspection = await reconnect.request(4, "codexhost/thread/inspect", { threadId });
      expect((inspection.result as JsonObject).effectiveModel).toEqual({
        id: "fake-model-v1.secondary",
      });
      session.succeedTurn();
      await reconnect.output.waitFor((m) => m.method === "turn/completed");
      const actualResume = await reconnect.request(5, "thread/resume", { threadId });
      expect((actualResume.result as JsonObject).model).toBe(selectedModel);
      const rejected = await reconnect.request(6, "turn/start", {
        threadId,
        model: "codexhost/claude-code",
        input: [{ type: "text", text: "must not send" }],
      });
      expect(rejected).toHaveProperty("error");
      const unsupported = await reconnect.request(7, "turn/start", {
        threadId,
        model: selectedModel,
        serviceTier: "flex",
        input: [{ type: "text", text: "must not send" }],
      });
      expect(unsupported).toHaveProperty("error");
      const startedCount = reconnect.output.messages.filter(
        (m) => m.method === "turn/started",
      ).length;
      const unknownModel = encodeHarnessPluginRoute({
        harnessId: harnessIdSchema.parse("pi"),
        model: harnessModelRefSchema.parse({ id: "does-not-exist" }),
      });
      const failedSelection = await reconnect.request(8, "turn/start", {
        threadId,
        model: unknownModel,
        input: [{ type: "text", text: "must not use the previous model" }],
      });
      expect(failedSelection).toHaveProperty("error");
      expect(reconnect.output.messages.filter((m) => m.method === "turn/started")).toHaveLength(
        startedCount,
      );
      const afterFailure = await reconnect.request(9, "codexhost/thread/inspect", { threadId });
      expect((afterFailure.result as JsonObject).effectiveModel).toEqual({
        id: "fake-model-v1.secondary",
      });

      const partialSelection = await reconnect.request(22, "turn/start", {
        threadId,
        model: encodeHarnessPluginRoute({
          harnessId: harnessIdSchema.parse("pi"),
          model: harnessModelRefSchema.parse({ id: "fake-model-v1.primary" }),
        }),
        effort: "unsupported",
        input: [{ type: "text", text: "must not send after partial selection" }],
      });
      expect(partialSelection).toHaveProperty("error");
      expect(reconnect.output.messages.filter((m) => m.method === "turn/started")).toHaveLength(
        startedCount,
      );
      const selectedState = await reconnect.request(23, "thread/resume", { threadId });
      expect((selectedState.result as JsonObject).model).toBe(
        encodeHarnessPluginRoute({
          harnessId: harnessIdSchema.parse("pi"),
          model: harnessModelRefSchema.parse({ id: "fake-model-v1.primary" }),
        }),
      );
      const saved = (await store.listThreads()).find((record) => record.hostThreadId === threadId);
      expect(
        decodeCreateRoute({
          id: 0,
          method: "thread/start",
          params: { model: saved?.transportModelId ?? "" },
        })?.model?.id,
      ).toBe("fake-model-v1.primary");
      expect(open).toHaveBeenCalledOnce();
      expect(native).not.toHaveBeenCalled();
      await local.close();
      await reconnect.running;
      const replacement = new MappingStore({ directory: path.join(directory, "store") });
      await replacement.initialize();
      const recovered = (await replacement.listThreads()).find(
        (record) => record.hostThreadId === threadId,
      );
      expect(recovered?.transportModelId).toBe(saved?.transportModelId);
      await replacement.close();
    },
  );
});
