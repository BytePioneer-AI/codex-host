import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkspace } from "../src/desktop-config.js";
import { rpcError } from "../src/errors.js";
import { encodeModel, modelCatalog, selectNativeModel, sessionState } from "../src/models.js";
import { snapshotSchema } from "../src/protocol.js";
import type { ZcodeTransport } from "../src/transport.js";
import { ZcodeAdapter } from "../src/adapter.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zcode-workspace-"));
  roots.push(root);
  const workspace = { workspacePath: root, workspaceKey: root };
  const settings = {
    model: {
      current: { providerId: "fixture", modelId: "model" },
      available: [{ ref: { providerId: "fixture", modelId: "model" }, label: "Fixture" }],
    },
    thoughtLevel: { enabled: false, available: [] },
    mode: { current: "build" },
  };
  const snapshot = {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId: "catalog-session",
      workspace,
      title: "",
      status: "idle",
      mode: "build",
      createdAt: 1,
      updatedAt: 1,
      sessionKind: "interactive",
    },
    settings,
    projection: { status: "idle", contextUsed: 0, contextWindow: 0 },
    messages: [],
    runtime: {},
  };
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "workspace/readState") throw rpcError(-32601, "Method not found");
    if (method === "workspace/readPresentation")
      return { workspace, mode: "build", slashCommands: [] };
    if (method === "session/create") return snapshot;
    if (method === "session/close") return { closed: true };
    throw new Error(`Unexpected method: ${method}`);
  });
  const environment: NodeJS.ProcessEnv = {};
  const transport = { options: { cwd: root, environment }, request } as unknown as ZcodeTransport;
  return { root, workspace, settings, snapshot, request, environment, transport };
}

describe("ZCode native workspace protocol compatibility", () => {
  it("keeps a working workspace/readState on the legacy path", async () => {
    const f = await fixture();
    f.request.mockResolvedValueOnce({ workspace: f.workspace, settings: f.settings });
    expect(await readWorkspace(f.transport)).toEqual({
      workspace: f.workspace,
      settings: f.settings,
      registryScope: "workspace",
    });
    expect(f.request).toHaveBeenCalledExactlyOnceWith("workspace/readState", {
      workspace: f.workspace,
    });
  });
  it("uses native deferred Sessions for the process-registry catalog and always closes them", async () => {
    const f = await fixture();
    expect(await readWorkspace(f.transport)).toEqual({
      workspace: f.workspace,
      settings: f.settings,
      registryScope: "process",
    });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "workspace/readState",
      "workspace/readPresentation",
      "session/create",
      "session/close",
    ]);
    expect(f.request).toHaveBeenCalledWith("session/create", {
      workspace: f.workspace,
      mode: "build",
      persistence: "deferred",
      titleGenerationEnabled: false,
      mcpServers: [],
    });
    expect(f.request).toHaveBeenLastCalledWith("session/close", {
      sessionId: "catalog-session",
      expectedPersistence: "deferred",
    });
  });
  it.each([-32010, -32602, -32000])("does not fall back for native error %s", async (code) => {
    const f = await fixture();
    const error = rpcError(code, "Native failure");
    f.request.mockRejectedValueOnce(error);
    await expect(readWorkspace(f.transport)).rejects.toBe(error);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("does not hide malformed legacy responses or timeouts", async () => {
    const f = await fixture();
    f.request.mockResolvedValueOnce({ workspace: f.workspace, settings: {} });
    await expect(readWorkspace(f.transport)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
    f.request.mockClear();
    f.request.mockRejectedValueOnce(new Error("timeout"));
    await expect(readWorkspace(f.transport)).rejects.toThrow("timeout");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("does not silently reinterpret an explicit legacy Provider registry file", async () => {
    const f = await fixture();
    f.environment.CODEXHOST_ZCODE_CONFIG = path.join(f.root, "legacy.json");
    await expect(readWorkspace(f.transport)).rejects.toThrow("provider_config.json");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("does not fall back when an existing workspace protocol rejects Provider registration", async () => {
    const f = await fixture();
    const config = path.join(f.root, "providers.json");
    await writeFile(
      config,
      JSON.stringify({ provider: { fixture: { kind: "anthropic", models: { model: {} } } } }),
    );
    f.environment.CODEXHOST_ZCODE_CONFIG = config;
    f.request
      .mockResolvedValueOnce({ workspace: f.workspace, settings: f.settings })
      .mockRejectedValueOnce(rpcError(-32601, "Registry method missing"));
    await expect(readWorkspace(f.transport)).rejects.toThrow("Registry method missing");
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "workspace/readState",
      "workspace/updateProviderRegistry",
    ]);
  });
  it("fails closed for an unknown protocol or a workspace identity mismatch", async () => {
    const f = await fixture();
    f.request
      .mockRejectedValueOnce(rpcError(-32601, "Missing state"))
      .mockRejectedValueOnce(rpcError(-32601, "Missing presentation"));
    await expect(readWorkspace(f.transport)).rejects.toThrow("Missing presentation");
    f.request.mockClear();
    f.request.mockRejectedValueOnce(rpcError(-32601, "Missing state")).mockResolvedValueOnce({
      workspace: { ...f.workspace, workspacePath: path.dirname(f.root) },
      mode: "build",
    });
    await expect(readWorkspace(f.transport)).rejects.toThrow("different workspace");
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("keeps reasoning selection native and does not add process-only options to legacy requests", async () => {
    const f = await fixture();
    const settings = snapshotSchema.parse({
      ...f.snapshot,
      settings: {
        ...f.settings,
        model: {
          current: { providerId: "fixture", modelId: "other", options: { reasoningLevel: "low" } },
          available: [
            {
              ref: { providerId: "fixture", modelId: "model" },
              label: "Fixture",
              reasoning: {
                levels: [
                  { value: "low", label: "Low" },
                  { value: "high", label: "High" },
                ],
                defaultLevel: "high",
              },
            },
          ],
        },
      },
    }).settings;
    const ref = encodeModel({ providerId: "fixture", modelId: "model" });
    expect(selectNativeModel(ref, settings, true)).toEqual({
      providerId: "fixture",
      modelId: "model",
      options: { reasoningLevel: "high" },
    });
    expect(selectNativeModel(ref, settings, true, "low").options?.reasoningLevel).toBe("low");
    expect(selectNativeModel(ref, settings, false)).toEqual({
      providerId: "fixture",
      modelId: "model",
    });
    expect(() => selectNativeModel(ref, settings, true, "invalid")).toThrow("reasoning level");
    const reasoning = settings.model.available[0]?.reasoning;
    if (!reasoning) throw new Error("Missing reasoning fixture");
    delete reasoning.defaultLevel;
    expect(() => selectNativeModel(ref, settings, true)).toThrow("reasoning level");
  });
  it("closes a malformed catalog snapshot and refuses to report success if cleanup fails", async () => {
    const f = await fixture();
    f.request
      .mockRejectedValueOnce(rpcError(-32601, "Missing"))
      .mockResolvedValueOnce({ workspace: f.workspace, mode: "build" })
      .mockResolvedValueOnce({ ...f.snapshot, settings: {} });
    await expect(readWorkspace(f.transport)).rejects.toThrow();
    expect(f.request).toHaveBeenLastCalledWith("session/close", {
      sessionId: "catalog-session",
      expectedPersistence: "deferred",
    });
    f.request
      .mockRejectedValueOnce(rpcError(-32601, "Missing"))
      .mockResolvedValueOnce({ workspace: f.workspace, mode: "build" })
      .mockResolvedValueOnce(f.snapshot)
      .mockResolvedValueOnce({ closed: false });
    await expect(readWorkspace(f.transport)).rejects.toThrow("did not close");
  });
  it("does not manufacture a current Model and accepts native reasoning levels without an enabled flag", async () => {
    const f = await fixture();
    const snapshot = snapshotSchema.parse({
      ...f.snapshot,
      settings: {
        ...f.settings,
        model: {
          available: [
            {
              ref: { providerId: "fixture", modelId: "other" },
              label: "Other",
              reasoning: { levels: [{ value: "high", label: "High" }] },
            },
          ],
        },
      },
    });
    expect(sessionState(snapshot).effectiveModel).toBeUndefined();
    const catalog = modelCatalog(snapshot.settings);
    expect(catalog.defaultModel).toBeUndefined();
    expect(catalog.models[0]?.supportedThinkingOptionIds).toEqual(["high"]);
    expect(
      modelCatalog(
        snapshotSchema.parse({
          ...f.snapshot,
          settings: { ...f.settings, model: { available: [] } },
        }).settings,
      ).models,
    ).toEqual([]);
  });
  it.each([false, true])(
    "inspects the process profile without persisting catalog Sessions (empty=%s)",
    async (empty) => {
      const f = await fixture();
      const store = path.join(f.root, "sessions.json"),
        log = path.join(f.root, "requests.jsonl");
      const adapter = new ZcodeAdapter({
        command: path.resolve("packages/adapters/zcode/test/fixtures/app-server.cjs"),
        environment: {
          ...process.env,
          CODEXHOST_DATA_DIR: f.root,
          ZCODE_FIXTURE_PROFILE: "process",
          ZCODE_FIXTURE_STORE: store,
          ZCODE_FIXTURE_LOG: log,
          ...(empty ? { ZCODE_FIXTURE_NO_MODELS: "1" } : {}),
        },
      });
      try {
        expect(await adapter.inspect({ cwd: f.root })).toMatchObject(
          empty
            ? { status: "unavailable", error: { code: "authenticationRequired" } }
            : { status: "ready" },
        );
        expect(JSON.parse(await readFile(store, "utf8"))).toEqual({});
        const requests = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(requests.map((r) => r.method)).toEqual([
          "workspace/readState",
          "workspace/readPresentation",
          "session/create",
          "session/close",
        ]);
        expect(
          requests.some(
            (r) => r.method === "session/send" || r.method === "provider/updateAccountConfig",
          ),
        ).toBe(false);
      } finally {
        await adapter.close();
      }
    },
  );
});
