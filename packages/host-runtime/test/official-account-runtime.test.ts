import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { OfficialAccountRuntime } from "../src/account/official-account-runtime.js";
import { NativeCodexCredentials } from "../src/account/native-codex-credentials.js";
import type { OfficialClientSession } from "../src/codex-runtime/official-runtime-owner.js";
import type { CodexRuntimeOutput } from "../src/codex-runtime/codex-runtime.js";
import { OfficialWorkGate } from "../src/codex-runtime/official-work-gate.js";
import { syntheticNativeCredentials } from "./fixtures/codex-account-fixtures.js";

async function fixture(stopExternalProcesses?: () => Promise<void>) {
  const native = NativeCodexCredentials.parse(syntheticNativeCredentials({ subject: "a" }));
  const credentialsByHome = new Map([["/synthetic/home", native]]);
  const readCredentials = vi.fn(async (home: string) => credentialsByHome.get(home) ?? null);
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
  const management: OfficialClientSession = {
    configure: vi.fn<(params: JsonObject) => void>(),
    initialize: vi.fn<(params: JsonObject) => Promise<JsonObject>>(async () => ({})),
    request: controlRequest,
    send: vi.fn<(value: JsonObject) => Promise<void>>(async () => {}),
    close: vi.fn<() => void>(),
  };
  let managementOutput: CodexRuntimeOutput | undefined;
  const owner = {
    gate,
    running: true,
    controlRequest,
    captureThreadSettings: vi.fn<(threads: readonly JsonObject[]) => void>(),
    start: vi.fn(async (...args: unknown[]) => {
      void args;
      owner.running = true;
      await management.initialize({
        clientInfo: { name: "codexhost_account_management", version: "1" },
        capabilities: { experimentalApi: true },
      });
    }),
    stop: vi.fn(async () => {
      owner.running = false;
    }),
    attachManagement: vi.fn((output: CodexRuntimeOutput): OfficialClientSession => {
      managementOutput = output;
      return management;
    }),
  };
  const version = vi.fn(async () => "0.153.4");
  const reconcile = vi.fn(async () => {});
  const environment: NodeJS.ProcessEnv = {};
  const runtime = new OfficialAccountRuntime({
    owner,
    sharedCodexHome: "/synthetic/home",
    readCredentials,
    environment,
    nativeVersion: version,
    reconcilePreviousWriter: reconcile,
    stopExternalProcesses: stopExternalProcesses ?? (async () => {}),
  });
  return {
    native,
    credentialsByHome,
    readCredentials,
    responses,
    owner,
    management,
    version,
    reconcile,
    environment,
    runtime,
    emitManagement: async (value: JsonObject) => {
      if (!managementOutput) throw new Error("Management output is not attached");
      await managementOutput({
        generation: 1,
        frame: Buffer.from(`${JSON.stringify(value)}\n`),
        value,
      });
    },
  };
}

describe("official native account checks", () => {
  it("only invokes external termination explicitly after owned exit", async () => {
    const stopExternal = vi.fn(async () => {});
    const f = await fixture(stopExternal);
    await expect(f.runtime.stopExternalProcesses()).rejects.toMatchObject({ code: "busy" });
    await f.runtime.stop();
    expect(stopExternal).not.toHaveBeenCalled();
    await f.runtime.stopExternalProcesses();
    expect(stopExternal).toHaveBeenCalledOnce();
    await f.runtime.start();
    expect(stopExternal).toHaveBeenCalledOnce();
  });
  it.each(["thread", "queue"] as const)(
    "refuses idle-only mutations with pending %s work",
    async (reason) => {
      const f = await fixture();
      f.responses["thread/list"] = {
        data: [{ id: "blocking", status: { type: reason === "thread" ? "active" : "idle" } }],
        nextCursor: null,
      };
      f.owner.controlRequest.mockImplementation(async (method, params) => ({
        result:
          method === "thread/list" && params.archived
            ? { data: [], nextCursor: null }
            : method === "thread/queue/list"
              ? { data: [{}], nextCursor: null }
              : (f.responses[method] ?? {}),
      }));
      await expect(f.runtime.assertNativeIdle()).rejects.toMatchObject({
        code: "busy",
      });
      expect(f.owner.stop).not.toHaveBeenCalled();
    },
  );
  it("initializes a persistent loopback management client before Desktop attaches", async () => {
    const f = await fixture();
    f.owner.running = false;
    await f.runtime.start();
    expect(f.owner.attachManagement).toHaveBeenCalledTimes(1);
    expect(f.management.configure).toHaveBeenCalledTimes(1);
    expect(f.management.initialize).toHaveBeenCalledTimes(1);
    expect(f.owner.start).toHaveBeenCalledWith({ mode: "task" });
    expect(f.owner.controlRequest.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "account/read",
    ]);
  });
  it("publishes management notifications to account subscribers", async () => {
    const f = await fixture();
    const listener = vi.fn();
    const unsubscribe = f.runtime.subscribe(listener);
    await f.emitManagement({ method: "account/login/completed", params: { loginId: "one" } });
    expect(listener).toHaveBeenCalledWith({
      method: "account/login/completed",
      params: { loginId: "one" },
    });
    unsubscribe();
    await f.emitManagement({ method: "account/login/completed", params: { loginId: "two" } });
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it("starts staging management-only and verifies credentials from the actual active home", async () => {
    const f = await fixture();
    const staged = NativeCodexCredentials.parse(syntheticNativeCredentials({ subject: "staged" }));
    f.credentialsByHome.set("/synthetic/staging", staged);
    f.responses["account/read"] = {
      account: { type: "chatgpt", email: staged.email ?? "staged@example.test" },
    };
    await f.runtime.start("/synthetic/staging");
    await f.runtime.verify(staged.identity);
    expect(f.owner.start).toHaveBeenCalledWith({
      homeOverride: "/synthetic/staging",
      mode: "management-only",
    });
    expect(f.readCredentials).toHaveBeenCalledWith("/synthetic/staging");
    expect(f.owner.controlRequest.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "account/read",
      "config/read",
      "account/read",
      "account/rateLimits/read",
    ]);
  });
  it("rejects unsupported versions before bootstrapping or changing any credential", async () => {
    const f = await fixture();
    f.owner.running = false;
    f.version.mockResolvedValue("0.153.5");
    await expect(f.runtime.preflight()).rejects.toMatchObject({ code: "unsupported-version" });
    expect(f.owner.start).not.toHaveBeenCalled();
    expect(f.owner.controlRequest).not.toHaveBeenCalled();
  });
  it("validates version before start and stops a newly started unsupported store", async () => {
    const unsupportedVersion = await fixture();
    unsupportedVersion.owner.running = false;
    unsupportedVersion.version.mockResolvedValue("0.153.5");
    await expect(unsupportedVersion.runtime.start()).rejects.toMatchObject({
      code: "unsupported-version",
    });
    expect(unsupportedVersion.owner.start).not.toHaveBeenCalled();

    const unsupportedStore = await fixture();
    unsupportedStore.owner.running = false;
    unsupportedStore.responses["config/read"] = {
      config: { cli_auth_credentials_store: "keyring" },
    };
    await expect(unsupportedStore.runtime.start()).rejects.toMatchObject({
      code: "unsupported-storage",
    });
    expect(unsupportedStore.owner.start).toHaveBeenCalledOnce();
    expect(unsupportedStore.owner.stop).toHaveBeenCalledOnce();
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
  it("keeps an omitted credentials-store value unsupported without native default evidence", async () => {
    const f = await fixture();
    f.responses["config/read"] = { config: {} };
    await expect(f.runtime.preflight()).rejects.toMatchObject({ code: "unsupported-storage" });
    expect(f.owner.stop).not.toHaveBeenCalled();
  });
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
      "account/read",
      "account/rateLimits/read",
    ]);
    expect(f.owner.controlRequest).toHaveBeenCalledWith("account/read", {
      refreshToken: true,
    });
    f.credentialsByHome.set(
      "/synthetic/home",
      NativeCodexCredentials.parse(syntheticNativeCredentials({ subject: "other" })),
    );
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
  it("keeps a successful cold preflight for idle proof and explicit stop", async () => {
    const f = await fixture();
    f.owner.running = false;
    await f.runtime.preflight();
    await f.runtime.assertNativeIdle();
    expect(f.owner.start).toHaveBeenCalledWith({ mode: "management-only" });
    expect(f.owner.stop).not.toHaveBeenCalled();
    expect(f.owner.running).toBe(true);
    await f.runtime.stop();
    expect(f.owner.stop).toHaveBeenCalledTimes(1);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(f.owner.running).toBe(false);
  });
  it("stops a cold bootstrap when preflight validation fails", async () => {
    const f = await fixture();
    f.owner.running = false;
    f.responses["config/read"] = { config: { cli_auth_credentials_store: "keyring" } };
    await expect(f.runtime.preflight()).rejects.toMatchObject({ code: "unsupported-storage" });
    expect(f.owner.start).toHaveBeenCalledOnce();
    expect(f.owner.stop).toHaveBeenCalledOnce();
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
      await expect(f.runtime.assertNativeIdle()).rejects.toMatchObject({
        code: "busy",
      });
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
      ephemeral: false,
      path: "/synthetic/home/sessions/loaded.jsonl",
      status: { type: "idle" },
      model: "selected",
      modelProvider: "provider",
      reasoningEffort: "low",
    };
    f.responses["thread/loaded/list"] = { data: [thread.id], nextCursor: null };
    f.responses["thread/read"] = { thread };
    const effective = {
      thread,
      model: "selected",
      modelProvider: "provider",
      serviceTier: "priority",
      cwd: "/synthetic/current",
      runtimeWorkspaceRoots: ["/synthetic/current"],
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
      activePermissionProfile: { id: ":workspace", extends: null },
      reasoningEffort: "low",
      multiAgentMode: "explicitRequestOnly",
      initialTurnsPage: null,
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    };
    f.responses["thread/resume"] = effective;
    f.responses["thread/backgroundTerminals/list"] = {
      data: [{ id: "terminal" }],
      nextCursor: null,
    };
    await expect(f.runtime.assertNativeIdle()).rejects.toMatchObject({
      code: "busy",
    });
    expect(f.owner.captureThreadSettings).not.toHaveBeenCalled();
    f.responses["thread/backgroundTerminals/list"] = { data: [], nextCursor: null };
    await f.runtime.assertNativeIdle();
    expect(f.owner.controlRequest).toHaveBeenCalledWith("thread/resume", {
      threadId: "loaded",
      excludeTurns: true,
    });
    expect(f.owner.captureThreadSettings).toHaveBeenCalledWith([effective]);
  });

  it.each([
    { ephemeral: true, path: "/synthetic/home/sessions/temporary.jsonl" },
    { ephemeral: false, path: null },
    { ephemeral: false, path: "" },
    {},
  ])("refuses non-restorable loaded native Thread metadata %j", async (metadata) => {
    const f = await fixture();
    const thread = { id: "temporary", status: { type: "idle" }, ...metadata };
    f.responses["thread/loaded/list"] = { data: [thread.id], nextCursor: null };
    f.responses["thread/read"] = { thread };
    f.responses["thread/resume"] = { thread };
    await expect(f.runtime.assertNativeIdle()).rejects.toMatchObject({
      code: "busy",
    });
    expect(f.owner.captureThreadSettings).not.toHaveBeenCalled();
    expect(f.owner.stop).not.toHaveBeenCalled();
  });

  it.each([
    { message: "no rollout found for thread id draft", expected: "busy" },
    { message: "another native request failure", expected: "invalid-native-response" },
  ])(
    "classifies native resume refusal without stopping the writer: $expected",
    async ({ message, expected }) => {
      const f = await fixture();
      f.runtime.gate.initialized();
      const thread = {
        id: "draft",
        ephemeral: false,
        status: { type: "idle" },
        path: "/synthetic/home/sessions/planned-not-materialized.jsonl",
      };
      f.responses["thread/loaded/list"] = { data: [thread.id], nextCursor: null };
      f.responses["thread/read"] = { thread };
      f.owner.controlRequest.mockImplementation(async (method) =>
        method === "thread/resume"
          ? { error: { code: -32600, message } }
          : { result: f.responses[method] ?? {} },
      );
      await expect(f.runtime.assertNativeIdle()).rejects.toMatchObject({ code: expected });
      expect(f.runtime.gate.phase).toBe("ready");
      expect(f.owner.stop).not.toHaveBeenCalled();
      expect(f.owner.captureThreadSettings).not.toHaveBeenCalled();
    },
  );

  it("rejects a repeated native pagination cursor instead of looping or reporting idle", async () => {
    const f = await fixture();
    f.responses["thread/list"] = { data: [], nextCursor: "again" };
    await expect(f.runtime.assertNativeIdle()).rejects.toMatchObject({
      code: "invalid-native-response",
    });
    expect(f.owner.controlRequest).toHaveBeenCalledTimes(2);
  });
});
