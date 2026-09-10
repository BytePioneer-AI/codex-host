import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { OfficialAccountRuntime } from "../src/account/official-account-runtime.js";
import { CodexCredentialFiles } from "../src/account/codex-credential-files.js";
import { NativeCodexCredentials } from "../src/account/native-codex-credentials.js";
import { OfficialWorkGate } from "../src/codex-runtime/official-work-gate.js";
import { MemoryCredentialFiles } from "./fixtures/memory-credential-files.js";
import { syntheticNativeCredentials } from "./fixtures/codex-account-fixtures.js";

async function fixture(persistentManagementClient = false) {
  const files = new MemoryCredentialFiles();
  const credentials = new CodexCredentialFiles({
    files,
    directory: "/synthetic/slots",
    sharedCodexHome: "/synthetic/home",
  });
  await credentials.initialize();
  const native = NativeCodexCredentials.parse(syntheticNativeCredentials({ subject: "a" }));
  files.contents.set("/synthetic/home/auth.json", Buffer.from(native.serializeForNativeStore()));
  const responses: Record<string, JsonObject> = {
    "config/read": { config: { cli_auth_credentials_store: "file" } },
    "account/read": { account: { type: "chatgpt", email: native.email ?? "a@example.test" } },
    "account/rateLimits/read": { rateLimits: {} },
    "thread/list": { data: [], nextCursor: null },
    "thread/loaded/list": { data: [], nextCursor: null },
    "thread/queue/list": { data: [], nextCursor: null },
    "thread/goal/get": { goal: null },
    "thread/backgroundTerminals/list": { data: [], nextCursor: null },
  };
  const gate = new OfficialWorkGate();
  const controlRequest = vi.fn<(method: string, params: JsonObject) => Promise<JsonObject>>(
    async (method) => ({
      result: responses[method] ?? {},
    }),
  );
  const owner = {
    gate,
    running: true,
    controlRequest,
    captureThreadSettings: vi.fn(async () => {}),
    start: vi.fn(async () => {
      owner.running = true;
    }),
    stop: vi.fn(async () => {
      owner.running = false;
    }),
    attach: vi.fn(() => ({
      configure: vi.fn(),
      initialize: vi.fn(async () => ({})),
      request: controlRequest,
      send: vi.fn(async () => {}),
      close: vi.fn(),
    })),
  };
  const version = vi.fn(async () => "0.153.4");
  const reconcile = vi.fn(async () => {});
  const environment: NodeJS.ProcessEnv = {};
  const runtime = new OfficialAccountRuntime({
    owner,
    credentials,
    environment,
    nativeVersion: version,
    reconcilePreviousWriter: reconcile,
    persistentManagementClient,
  });
  return { files, credentials, native, responses, owner, version, reconcile, environment, runtime };
}

describe("official native account checks", () => {
  it("initializes a persistent loopback management client before Desktop attaches", async () => {
    const f = await fixture(true);
    f.owner.running = false;
    await f.runtime.start();
    expect(f.owner.attach).toHaveBeenCalledTimes(1);
    const control = f.owner.attach.mock.results[0]?.value;
    expect(control?.configure).toHaveBeenCalledTimes(1);
    expect(control?.initialize).toHaveBeenCalledTimes(1);
  });
  it("rejects unsupported versions before bootstrapping or changing any credential", async () => {
    const f = await fixture();
    f.owner.running = false;
    f.version.mockResolvedValue("0.153.5");
    await expect(f.runtime.preflight()).rejects.toMatchObject({ code: "unsupported-version" });
    expect(f.owner.start).not.toHaveBeenCalled();
    expect(f.owner.controlRequest).not.toHaveBeenCalled();
  });
  it.each(["keyring", "auto", "unknown"])(
    "rejects %s without touching the existing backend",
    async (store) => {
      const f = await fixture();
      f.responses["config/read"] = { config: { cli_auth_credentials_store: store } };
      await expect(f.runtime.preflight()).rejects.toMatchObject({ code: "unsupported-storage" });
      expect(f.owner.stop).not.toHaveBeenCalled();
    },
  );
  it("rejects API key mode and external authentication overrides", async () => {
    const f = await fixture();
    f.responses["account/read"] = { account: { type: "apiKey" } };
    await expect(f.runtime.preflight()).rejects.toMatchObject({ code: "unsupported-storage" });
    f.responses["account/read"] = { account: null };
    f.environment.OPENAI_API_KEY = "synthetic";
    await expect(f.runtime.preflight()).rejects.toMatchObject({ code: "unsupported-storage" });
  });
  it("checks authenticated quota before comparing the final native identity, without inference", async () => {
    const f = await fixture();
    await f.runtime.verify(f.native.identity);
    expect(f.owner.controlRequest.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "account/rateLimits/read",
      "account/read",
    ]);
    f.responses["account/read"] = { account: { type: "chatgpt", email: "other@example.test" } };
    await expect(f.runtime.verify(f.native.identity)).rejects.toMatchObject({
      code: "authentication-failed",
    });
  });
  it("does not accept a quota RPC failure as authenticated and does not expose its body", async () => {
    const f = await fixture();
    f.owner.controlRequest.mockImplementation(async (method) =>
      method === "account/rateLimits/read"
        ? { error: { message: "synthetic-secret" } }
        : { result: f.responses[method] ?? {} },
    );
    await expect(f.runtime.verify(f.native.identity)).rejects.toThrow("invalid-native-response");
  });
  it("reconciles earlier writers before configuration-only start and confirms stop afterwards", async () => {
    const f = await fixture();
    f.owner.running = false;
    await f.runtime.preflight();
    expect(f.owner.start).toHaveBeenCalledWith(false);
    expect(f.owner.stop).toHaveBeenCalledTimes(2);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(f.owner.running).toBe(false);
  });
  it("cannot bootstrap beside an unconfirmed previous process", async () => {
    const f = await fixture();
    f.owner.running = false;
    f.reconcile.mockRejectedValue(new Error("unconfirmed"));
    await expect(f.runtime.preflight()).rejects.toThrow("unconfirmed");
    expect(f.owner.start).not.toHaveBeenCalled();
  });
  it.each(["active", "usageLimited", "paused"])(
    "blocks persisted %s goals even when no Thread is loaded",
    async (status) => {
      const f = await fixture();
      f.owner.controlRequest.mockImplementation(async (method, params) => ({
        result:
          method === "thread/list"
            ? params.archived
              ? { data: [], nextCursor: null }
              : { data: [{ id: "persisted", status: { type: "notLoaded" } }], nextCursor: null }
            : method === "thread/goal/get"
              ? { goal: { status } }
              : (f.responses[method] ?? {}),
      }));
      await expect(f.runtime.assertNativeIdle()).rejects.toMatchObject({ code: "busy" });
      const listCalls = f.owner.controlRequest.mock.calls.filter(
        ([method]) => method === "thread/list",
      );
      expect(listCalls.map(([, params]) => params.archived)).toEqual([false, true]);
      expect(listCalls[0]?.[1]).toMatchObject({
        modelProviders: [],
        sourceKinds: expect.arrayContaining(["exec", "subAgentOther", "unknown"]),
      });
    },
  );
  it("does not call unsupported queue or goal APIs for archived history", async () => {
    const f = await fixture();
    f.owner.controlRequest.mockImplementation(async (method, params) => {
      if (method === "thread/list")
        return {
          result: params.archived
            ? { data: [{ id: "archived", status: { type: "notLoaded" } }], nextCursor: null }
            : { data: [], nextCursor: null },
        };
      if (method === "thread/queue/list" || method === "thread/goal/get")
        return { error: { code: -32600, message: "unsupported for archived Thread" } };
      return { result: f.responses[method] ?? {} };
    });
    await f.runtime.assertNativeIdle();
    expect(f.owner.controlRequest).not.toHaveBeenCalledWith(
      "thread/queue/list",
      expect.objectContaining({ threadId: "archived" }),
    );
    expect(f.owner.controlRequest).not.toHaveBeenCalledWith(
      "thread/goal/get",
      expect.objectContaining({ threadId: "archived" }),
    );
  });

  it("checks loaded background terminals and captures the live Model rather than stale list metadata", async () => {
    const f = await fixture();
    const thread = {
      id: "loaded",
      status: { type: "idle" },
      model: "selected",
      modelProvider: "provider",
      reasoningEffort: "low",
    };
    f.responses["thread/loaded/list"] = { data: [thread.id], nextCursor: null };
    f.responses["thread/read"] = { thread };
    f.responses["thread/backgroundTerminals/list"] = {
      data: [{ id: "terminal" }],
      nextCursor: null,
    };
    await expect(f.runtime.assertNativeIdle()).rejects.toThrow("busy");
    expect(f.owner.captureThreadSettings).not.toHaveBeenCalled();
    f.responses["thread/backgroundTerminals/list"] = { data: [], nextCursor: null };
    await f.runtime.assertNativeIdle();
    expect(f.owner.captureThreadSettings).toHaveBeenCalledWith([thread]);
  });

  it("rejects a repeated native pagination cursor instead of looping or reporting idle", async () => {
    const f = await fixture();
    f.responses["thread/list"] = { data: [], nextCursor: "again" };
    await expect(f.runtime.assertNativeIdle()).rejects.toMatchObject({
      code: "invalid-native-response",
    });
    expect(f.owner.controlRequest).toHaveBeenCalledTimes(2);
  });
});
