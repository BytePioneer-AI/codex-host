import { describe, expect, it, vi } from "vitest";

import {
  installRendererDraftPrewarmPolicy,
  installRendererDraftPrewarmPolicyDirect,
  selectRendererRequestManager,
} from "../src/renderer-draft-prewarm-policy.js";
import {
  installDraftPrewarmPolicyBridge,
  installDraftPrewarmPolicyInRenderer,
  type DraftPrewarmPolicyTarget,
  type RendererDebugger,
  type RendererHostRequestBridge,
  type RendererHostRequestManager,
  type RendererWebContents,
} from "../src/renderer-draft-prewarm-runtime.js";

function requestManagerFixture(): Required<RendererHostRequestManager> {
  return {
    onNotification: vi.fn(),
    onRequest: vi.fn(),
    dispatchAppServerResponse: vi.fn(),
  };
}

function requestBridgeFixture(
  input: {
    sendRequest?: RendererHostRequestBridge["sendRequest"];
    prewarmThreadStart?: RendererHostRequestBridge["prewarmThreadStart"];
  } = {},
): RendererHostRequestBridge {
  return {
    sendRequest: input.sendRequest ?? vi.fn(),
    prewarmThreadStart: input.prewarmThreadStart ?? vi.fn(),
    enqueueRequest: vi.fn(),
    onResult: vi.fn(),
    onError: vi.fn(),
  };
}

function remoteRequestBridgeFixture(): {
  bridge: RendererHostRequestBridge;
  directSend: ReturnType<typeof vi.fn>;
} {
  let nextRequestId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  const directSend = vi.fn((): Promise<unknown> => Promise.resolve({}));
  const bridge: RendererHostRequestBridge = {
    sendRequest: directSend,
    prewarmThreadStart: vi.fn(),
    enqueueRequest(method, parameters, _options, dispatch) {
      const id = nextRequestId;
      nextRequestId += 1;
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      dispatch?.({ id, method, params: parameters });
      return promise;
    },
    onResult(id, result) {
      const entry = pending.get(Number(id));
      pending.delete(Number(id));
      entry?.resolve(result);
    },
    onError(id, error) {
      const entry = pending.get(Number(id));
      pending.delete(Number(id));
      entry?.reject(error);
    },
  };
  return { bridge, directSend };
}

function emitBridgeOutput(
  manager: Required<RendererHostRequestManager>,
  processHandle: string,
  value: Record<string, unknown> | string,
): void {
  const text = typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
  manager.onNotification("process/outputDelta", {
    processHandle,
    stream: "stdout",
    deltaBase64: Buffer.from(text, "utf8").toString("base64"),
    capReached: false,
  });
}

function remoteNotificationTargetFixture(hostId = "remote-control:fixture-host"): {
  target: DraftPrewarmPolicyTarget;
  emit(method: string, parameters: unknown): void;
} {
  const listeners = new Set<(event: Event) => void>();
  return {
    target: {
      addEventListener(type, listener) {
        if (type === "message") listeners.add(listener);
      },
      removeEventListener(type, listener) {
        if (type === "message") listeners.delete(listener);
      },
    },
    emit(method, parameters) {
      const event = {
        data: { type: "mcp-notification", hostId, method, params: parameters },
      } as MessageEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

function emitRemoteBridgeOutput(
  fixture: ReturnType<typeof remoteNotificationTargetFixture>,
  processHandle: string,
  value: Record<string, unknown> | string,
): void {
  const text = typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
  fixture.emit("process/outputDelta", {
    processHandle,
    stream: "stdout",
    deltaBase64: Buffer.from(text, "utf8").toString("base64"),
    capReached: false,
  });
}

function writtenBridgeFrames(directSend: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return directSend.mock.calls
    .filter(([method]) => method === "process/writeStdin")
    .map(([, parameters]) => {
      const deltaBase64 = (parameters as { deltaBase64: string }).deltaBase64;
      return JSON.parse(Buffer.from(deltaBase64, "base64").toString("utf8")) as Record<
        string,
        unknown
      >;
    });
}

function rendererFixture(
  options: {
    candidateCount?: number;
    hostId?: string;
    includePrewarmedThreadManager?: boolean;
  } = {},
): {
  contents: RendererWebContents;
  sendCommand: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
} {
  let attached = false;
  const attach = vi.fn(() => {
    attached = true;
  });
  const detach = vi.fn(() => {
    attached = false;
  });
  const sendCommand = vi.fn(
    async (method: string, parameters: Record<string, unknown> = {}): Promise<unknown> => {
      if (method === "Runtime.enable") return {};
      if (method === "Runtime.evaluate") return { result: { objectId: "manager-result" } };
      if (method === "Runtime.getProperties") {
        switch (parameters.objectId) {
          case "manager-result":
            return {
              result: [
                { name: "candidateCount", value: { value: options.candidateCount ?? 1 } },
                { name: "hostId", value: { value: options.hostId ?? "local" } },
                { name: "manager", value: { objectId: "outer-request-manager" } },
                { name: "requestClient", value: { objectId: "request-client" } },
                ...(options.includePrewarmedThreadManager === false
                  ? []
                  : [
                      {
                        name: "prewarmedThreadManager",
                        value: { objectId: "prewarm-manager" },
                      },
                    ]),
              ],
            };
          default:
            throw new Error(`Unexpected Runtime.getProperties object: ${parameters.objectId}`);
        }
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: { state: "ready", reason: "owned-request-bridge" } } };
      }
      throw new Error(`Unexpected CDP command: ${method}`);
    },
  );
  const debugger_: RendererDebugger = {
    isAttached: () => attached,
    attach,
    detach,
    sendCommand,
  };
  return {
    contents: {
      isDestroyed: () => false,
      getType: () => "window",
      debugger: debugger_,
    },
    sendCommand,
    attach,
    detach,
  };
}

describe("Renderer draft prewarm policy", () => {
  it("selects the request manager owned by the active remote Composer Host", () => {
    const localManager = {};
    const remoteManager = {};
    const local = {
      manager: localManager,
      requestClient: { hostId: "local" },
      hostId: "local",
      prewarmedThreadManager: null,
    };
    const remote = {
      manager: remoteManager,
      requestClient: { hostId: "remote-ssh-discovered:mac" },
      hostId: "remote-ssh-discovered:mac",
      prewarmedThreadManager: {},
    };

    expect(
      selectRendererRequestManager(
        [local, remote, { ...remote, requestClient: remote.requestClient }],
        ["remote-ssh-discovered:mac", "remote-ssh-discovered:mac"],
      ),
    ).toEqual(remote);
  });

  it("fails closed when the active Composer exposes conflicting Hosts", () => {
    expect(
      selectRendererRequestManager(
        [
          {
            manager: {},
            requestClient: {},
            hostId: "remote-ssh-discovered:mac",
            prewarmedThreadManager: null,
          },
        ],
        ["local", "remote-ssh-discovered:mac"],
      ),
    ).toBeNull();
  });

  it("retains the single-manager fallback when the Composer has no Host markers", () => {
    const candidate = {
      manager: {},
      requestClient: {},
      hostId: "local",
      prewarmedThreadManager: null,
    };
    expect(selectRendererRequestManager([candidate], [])).toBe(candidate);
  });

  it("generates syntactically valid main-process code", async () => {
    const evaluate = vi.fn(async (expression: string): Promise<unknown> => {
      expect(() => new Function(`return ${expression}`)).not.toThrow();
      return { state: "ready", reason: "owned-request-bridge" };
    });
    const inspector = {
      async evaluate<T>(expression: string): Promise<T> {
        return (await evaluate(expression)) as T;
      },
    };

    await expect(installRendererDraftPrewarmPolicy(inspector, 17)).resolves.toEqual({
      state: "ready",
      reason: "owned-request-bridge",
    });
    expect(evaluate).toHaveBeenCalledOnce();
    const expression = evaluate.mock.calls[0]?.[0] ?? "";
    expect(expression).toContain("webContents.fromId(17)");
    expect(expression).not.toContain("typeof value.requestClient.enqueueRequest === 'function'");
    expect(expression).toContain("resolvePrewarmedThreadManager");
    expect(expression).toContain("discardAllPrewarmedThreads");
    expect(expression).toContain("executionTargetHostId");
    expect(expression).toContain("permissionsHostId");
  });

  it("retries while the current Renderer request manager is mounting", async () => {
    const evaluate = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("Renderer request manager is ambiguous"))
      .mockResolvedValue({ state: "ready", reason: "owned-request-bridge" });
    const inspector = {
      async evaluate<T>(): Promise<T> {
        return (await evaluate()) as T;
      },
    };

    await expect(installRendererDraftPrewarmPolicy(inspector, 17)).resolves.toEqual({
      state: "ready",
      reason: "owned-request-bridge",
    });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("installs the fixed policy on the uniquely owned Host request bridge", async () => {
    const fixture = rendererFixture();

    await expect(
      installDraftPrewarmPolicyInRenderer(
        fixture.contents,
        "synthetic-manager-expression",
        "function syntheticPolicy() {}",
      ),
    ).resolves.toEqual({ state: "ready", reason: "owned-request-bridge" });

    expect(fixture.attach).toHaveBeenCalledWith("1.3");
    expect(fixture.detach).toHaveBeenCalledOnce();
    expect(fixture.sendCommand).toHaveBeenCalledWith("Runtime.evaluate", {
      expression: "synthetic-manager-expression",
    });
    expect(fixture.sendCommand).toHaveBeenCalledWith(
      "Runtime.callFunctionOn",
      expect.objectContaining({
        objectId: "outer-request-manager",
        functionDeclaration: "function syntheticPolicy() {}",
        arguments: [
          { objectId: "request-client" },
          { value: "local" },
          { objectId: "prewarm-manager" },
        ],
      }),
    );
  });

  it("installs the fixed policy on a uniquely owned remote Host request bridge", async () => {
    const fixture = rendererFixture({ hostId: "remote-ssh-discovered:mac" });

    await expect(
      installDraftPrewarmPolicyInRenderer(
        fixture.contents,
        "synthetic-manager-expression",
        "function syntheticPolicy() {}",
      ),
    ).resolves.toEqual({ state: "ready", reason: "owned-request-bridge" });

    expect(fixture.sendCommand).toHaveBeenCalledWith(
      "Runtime.callFunctionOn",
      expect.objectContaining({
        objectId: "outer-request-manager",
        arguments: [
          { objectId: "request-client" },
          { value: "remote-ssh-discovered:mac" },
          { objectId: "prewarm-manager" },
        ],
      }),
    );
  });

  it.each([
    [{ candidateCount: 2 }, "request manager is ambiguous"],
    [{ hostId: "" }, "request manager is ambiguous"],
    [{ includePrewarmedThreadManager: false }, "prewarmed Thread manager is unavailable"],
  ] as const)("fails closed for an unsupported request bridge", async (options, error) => {
    const fixture = rendererFixture(options);

    await expect(
      installDraftPrewarmPolicyInRenderer(fixture.contents, "manager", "policy"),
    ).rejects.toThrow(error);
    expect(fixture.detach).toHaveBeenCalledOnce();
  });

  it("rejects an unavailable owned Renderer before attaching", async () => {
    await expect(installDraftPrewarmPolicyInRenderer(null, "manager", "policy")).rejects.toThrow(
      "Owned Renderer is unavailable",
    );
  });

  it("clears drafts through the current prewarmed Thread manager", async () => {
    const discardAllPrewarmedThreads = vi.fn();
    const sendRequest = vi.fn();
    const prewarmThreadStart = vi.fn();
    const manager = requestManagerFixture();
    const bridge = requestBridgeFixture({ sendRequest, prewarmThreadStart });
    const target: DraftPrewarmPolicyTarget = {};
    installDraftPrewarmPolicyBridge(manager, bridge, "local", target, {
      discardAllPrewarmedThreads,
    });
    const policy = target.__codexhostDraftPrewarmPolicyV1 as { clear(): Promise<void> };

    await policy.clear();

    expect(discardAllPrewarmedThreads).toHaveBeenCalledOnce();
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("publishes the exact owned request target before announcing the policy", () => {
    const manager = requestManagerFixture();
    const bridge = requestBridgeFixture();
    let announcedPolicy: unknown;
    const target: DraftPrewarmPolicyTarget = {
      dispatchEvent: vi.fn(() => {
        announcedPolicy = target.__codexhostDraftPrewarmPolicyV1;
        return true;
      }),
    };

    installDraftPrewarmPolicyBridge(manager, bridge, "remote-ssh-discovered:mac", target, {
      discardAllPrewarmedThreads: vi.fn(),
    });

    const policy = target.__codexhostDraftPrewarmPolicyV1 as {
      requestTarget(): RendererHostRequestManager;
    };
    expect(announcedPolicy).toBe(policy);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.requestTarget()).toBe(manager);
    expect(target.dispatchEvent).toHaveBeenCalledOnce();
  });

  it("keeps the selected route when the same Host bridge is reconciled", () => {
    const sendRequest = vi.fn();
    const prewarmThreadStart = vi.fn();
    const manager = requestManagerFixture();
    const bridge = requestBridgeFixture({ sendRequest, prewarmThreadStart });
    const target: DraftPrewarmPolicyTarget = {};
    const prewarmedThreadManager = { discardAllPrewarmedThreads: vi.fn() };
    installDraftPrewarmPolicyBridge(
      manager,
      bridge,
      "remote-ssh-discovered:mac",
      target,
      prewarmedThreadManager,
    );
    const first = target.__codexhostDraftPrewarmPolicyV1 as {
      hostId: string;
      select(model: string | null): boolean;
    };
    first.select("codexhost/claude-code-native");

    installDraftPrewarmPolicyBridge(
      manager,
      bridge,
      "remote-ssh-discovered:mac",
      target,
      prewarmedThreadManager,
    );

    expect(target.__codexhostDraftPrewarmPolicyV1).toBe(first);
    expect(first.hostId).toBe("remote-ssh-discovered:mac");
    void bridge.sendRequest("thread/start", { model: "gpt-5" });
    expect(sendRequest).toHaveBeenCalledWith("thread/start", {
      model: "codexhost/claude-code-native",
    });
  });

  it("routes the current request client's direct and prewarm Thread starts", async () => {
    const sendRequest = vi.fn<(method: string, parameters: unknown) => Promise<void>>(
      async () => undefined,
    );
    const prewarmThreadStart = vi.fn(async (parameters: unknown) => parameters);
    const manager = requestManagerFixture();
    const bridge = requestBridgeFixture({ sendRequest, prewarmThreadStart });
    const target: DraftPrewarmPolicyTarget = {};
    installDraftPrewarmPolicyBridge(manager, bridge, "local", target, {
      discardAllPrewarmedThreads: vi.fn(),
    });
    const policy = target.__codexhostDraftPrewarmPolicyV1 as {
      select(model: string | null): boolean;
    };

    policy.select("codexhost/pi-native");
    await bridge.sendRequest("thread/start", { cwd: "/tmp/project", model: "gpt-5" });
    await bridge.prewarmThreadStart?.({ cwd: "/tmp/project", model: "gpt-5" });
    await bridge.prewarmThreadStart?.({ ephemeral: true, model: "gpt-5" });

    expect(sendRequest).toHaveBeenCalledWith("thread/start", {
      cwd: "/tmp/project",
      model: "codexhost/pi-native",
    });
    expect(prewarmThreadStart).toHaveBeenNthCalledWith(1, {
      cwd: "/tmp/project",
      model: "codexhost/pi-native",
    });
    expect(prewarmThreadStart).toHaveBeenNthCalledWith(2, {
      ephemeral: true,
      model: "gpt-5",
    });
  });

  it("tunnels private Host requests through the stock Remote Control app-server", async () => {
    const manager = requestManagerFixture();
    const originalNotification = manager.onNotification as ReturnType<typeof vi.fn>;
    const originalServerRequest = manager.onRequest as ReturnType<typeof vi.fn>;
    const originalServerResponse = manager.dispatchAppServerResponse as ReturnType<typeof vi.fn>;
    const { bridge, directSend } = remoteRequestBridgeFixture();
    const notifications = remoteNotificationTargetFixture();
    const target = notifications.target;
    installDraftPrewarmPolicyBridge(manager, bridge, "remote-control:fixture-host", target, {
      discardAllPrewarmedThreads: vi.fn(),
    });

    const inspectPromise = bridge.sendRequest("codexhost/harness/inspect", {
      harnessId: "claude-code",
    }) as Promise<unknown>;
    const spawnParameters = directSend.mock.calls[0]?.[1] as {
      command: string[];
      processHandle: string;
    };
    const encodedCommandIndex = spawnParameters.command.indexOf("-EncodedCommand") + 1;
    expect(encodedCommandIndex).toBeGreaterThan(0);
    const encodedCommand = spawnParameters.command[encodedCommandIndex];
    const encodedCommandBytes = atob(encodedCommand ?? "");
    let decodedCommand = "";
    for (let index = 0; index < encodedCommandBytes.length; index += 2) {
      decodedCommand += String.fromCharCode(
        encodedCommandBytes.charCodeAt(index) | (encodedCommandBytes.charCodeAt(index + 1) << 8),
      );
    }
    expect(decodedCommand).toContain("--codexhost-remote-control-bridge");
    expect(decodedCommand).toContain("remote-control-bridge-v1.json");
    expect(directSend).toHaveBeenCalledWith(
      "process/spawn",
      expect.objectContaining({
        command: expect.arrayContaining(["powershell.exe", "-EncodedCommand"]),
        cwd: "C:\\",
        streamStdin: true,
        streamStdoutStderr: true,
        outputBytesCap: null,
        timeoutMs: null,
      }),
    );
    expect(directSend).not.toHaveBeenCalledWith("codexhost/harness/inspect", expect.anything());
    const processHandle = spawnParameters.processHandle;

    emitRemoteBridgeOutput(notifications, processHandle, {
      method: "codexhost/remote-control-bridge/ready",
      params: { protocolVersion: 1 },
    });
    await vi.waitFor(() => expect(writtenBridgeFrames(directSend)).toHaveLength(1));
    const initialize = writtenBridgeFrames(directSend)[0];
    expect(initialize).toMatchObject({ method: "initialize" });

    emitRemoteBridgeOutput(notifications, processHandle, { id: initialize?.id, result: {} });
    await vi.waitFor(() => expect(writtenBridgeFrames(directSend)).toHaveLength(3));
    const frames = writtenBridgeFrames(directSend);
    expect(frames[1]).toEqual({ method: "initialized", params: {} });
    expect(frames[2]).toMatchObject({
      method: "codexhost/harness/inspect",
      params: { harnessId: "claude-code" },
    });

    emitRemoteBridgeOutput(notifications, processHandle, {
      id: frames[2]?.id,
      result: { harnessId: "claude-code", status: "ready" },
    });
    await expect(inspectPromise).resolves.toEqual({
      harnessId: "claude-code",
      status: "ready",
    });

    emitRemoteBridgeOutput(notifications, processHandle, {
      method: "thread/started",
      params: { thread: { id: "external-1", modelProvider: "codexhost" } },
    });
    expect(originalNotification).toHaveBeenCalledWith("thread/started", {
      thread: { id: "external-1", modelProvider: "codexhost" },
    });

    const readPromise = bridge.sendRequest("thread/read", {
      threadId: "external-1",
    }) as Promise<unknown>;
    await vi.waitFor(() => expect(writtenBridgeFrames(directSend)).toHaveLength(4));
    const read = writtenBridgeFrames(directSend)[3];
    expect(read).toMatchObject({ method: "thread/read", params: { threadId: "external-1" } });
    emitRemoteBridgeOutput(notifications, processHandle, {
      id: read?.id,
      result: { thread: { id: "external-1" } },
    });
    await expect(readPromise).resolves.toEqual({ thread: { id: "external-1" } });

    emitRemoteBridgeOutput(notifications, processHandle, {
      id: -71,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "external-1" },
    });
    const bridgedServerRequest = originalServerRequest.mock.lastCall?.[0] as Record<
      string,
      unknown
    >;
    expect(bridgedServerRequest).toMatchObject({
      method: "item/commandExecution/requestApproval",
      params: { threadId: "external-1" },
    });
    expect(bridgedServerRequest.id).toEqual(expect.any(String));
    expect(bridgedServerRequest.id).not.toBe(-71);

    manager.dispatchAppServerResponse("item/commandExecution/requestApproval", {
      id: -71,
      result: { decision: "decline" },
    });
    expect(originalServerResponse).toHaveBeenCalledWith("item/commandExecution/requestApproval", {
      id: -71,
      result: { decision: "decline" },
    });
    expect(writtenBridgeFrames(directSend)).toHaveLength(4);

    manager.dispatchAppServerResponse("item/commandExecution/requestApproval", {
      id: bridgedServerRequest.id,
      result: { decision: "accept" },
    });
    await vi.waitFor(() => expect(writtenBridgeFrames(directSend)).toHaveLength(5));
    expect(writtenBridgeFrames(directSend)[4]).toEqual({
      id: -71,
      result: { decision: "accept" },
    });
  });

  it("routes external Thread management from persisted ownership without restoring its Harness", async () => {
    const manager = requestManagerFixture();
    const { bridge, directSend } = remoteRequestBridgeFixture();
    const notifications = remoteNotificationTargetFixture();
    installDraftPrewarmPolicyBridge(
      manager,
      bridge,
      "remote-control:fixture-host",
      notifications.target,
      { discardAllPrewarmedThreads: vi.fn() },
    );

    const archive = bridge.sendRequest("thread/archive", {
      threadId: "external-after-reload",
    }) as Promise<unknown>;
    const spawn = directSend.mock.calls.find(([method]) => method === "process/spawn");
    expect(spawn).toBeDefined();
    const processHandle = (spawn?.[1] as { processHandle: string }).processHandle;
    emitRemoteBridgeOutput(notifications, processHandle, {
      method: "codexhost/remote-control-bridge/ready",
      params: { protocolVersion: 1 },
    });
    await vi.waitFor(() => expect(writtenBridgeFrames(directSend)).toHaveLength(1));
    const initialize = writtenBridgeFrames(directSend)[0];
    emitRemoteBridgeOutput(notifications, processHandle, { id: initialize?.id, result: {} });
    await vi.waitFor(() => expect(writtenBridgeFrames(directSend)).toHaveLength(3));
    const ownership = writtenBridgeFrames(directSend)[2];
    expect(ownership).toMatchObject({
      method: "codexhost/thread/ownership/list",
      params: { threadIds: ["external-after-reload"] },
    });
    emitRemoteBridgeOutput(notifications, processHandle, {
      id: ownership?.id,
      result: {
        threads: [
          {
            threadId: "external-after-reload",
            owner: "external",
            harnessId: "claude-code",
          },
        ],
      },
    });
    await vi.waitFor(() => expect(writtenBridgeFrames(directSend)).toHaveLength(4));
    const bridgedArchive = writtenBridgeFrames(directSend)[3];
    expect(bridgedArchive).toMatchObject({
      method: "thread/archive",
      params: { threadId: "external-after-reload" },
    });
    emitRemoteBridgeOutput(notifications, processHandle, {
      id: bridgedArchive?.id,
      result: {},
    });

    await expect(archive).resolves.toEqual({});
    expect(directSend).not.toHaveBeenCalledWith("thread/archive", expect.anything());
    expect(
      writtenBridgeFrames(directSend).some(({ method }) => method === "codexhost/thread/inspect"),
    ).toBe(false);
  });

  it("keeps an unknown official Thread on the stock Remote Control app-server", async () => {
    const manager = requestManagerFixture();
    const { bridge, directSend } = remoteRequestBridgeFixture();
    const notifications = remoteNotificationTargetFixture();
    installDraftPrewarmPolicyBridge(
      manager,
      bridge,
      "remote-control:fixture-host",
      notifications.target,
      { discardAllPrewarmedThreads: vi.fn() },
    );

    const read = bridge.sendRequest("thread/read", {
      threadId: "official-after-reload",
    }) as Promise<unknown>;
    const spawn = directSend.mock.calls.find(([method]) => method === "process/spawn");
    const processHandle = (spawn?.[1] as { processHandle: string }).processHandle;
    emitRemoteBridgeOutput(notifications, processHandle, {
      method: "codexhost/remote-control-bridge/ready",
      params: { protocolVersion: 1 },
    });
    await vi.waitFor(() => expect(writtenBridgeFrames(directSend)).toHaveLength(1));
    const initialize = writtenBridgeFrames(directSend)[0];
    emitRemoteBridgeOutput(notifications, processHandle, { id: initialize?.id, result: {} });
    await vi.waitFor(() => expect(writtenBridgeFrames(directSend)).toHaveLength(3));
    const ownership = writtenBridgeFrames(directSend)[2];
    expect(ownership).toMatchObject({
      method: "codexhost/thread/ownership/list",
      params: { threadIds: ["official-after-reload"] },
    });
    emitRemoteBridgeOutput(notifications, processHandle, {
      id: ownership?.id,
      result: {
        threads: [{ threadId: "official-after-reload", owner: "codex" }],
      },
    });

    await expect(read).resolves.toEqual({});
    expect(directSend).toHaveBeenCalledWith("thread/read", {
      threadId: "official-after-reload",
    });
    expect(writtenBridgeFrames(directSend)).toHaveLength(3);

    await bridge.sendRequest("thread/read", { threadId: "official-after-reload" });
    expect(directSend).toHaveBeenCalledTimes(6);
    expect(writtenBridgeFrames(directSend)).toHaveLength(3);
  });

  it("leaves stock Remote Control requests direct and terminates its bridge on dispose", async () => {
    const manager = requestManagerFixture();
    const { bridge, directSend } = remoteRequestBridgeFixture();
    const target: DraftPrewarmPolicyTarget = {};
    installDraftPrewarmPolicyBridge(manager, bridge, "remote-control:fixture-host", target, {
      discardAllPrewarmedThreads: vi.fn(),
    });

    await bridge.sendRequest("model/list", {});
    await bridge.sendRequest("thread/start", { model: "gpt-5", cwd: "C:\\workspace" });
    expect(directSend).toHaveBeenNthCalledWith(1, "model/list", {});
    expect(directSend).toHaveBeenNthCalledWith(2, "thread/start", {
      model: "gpt-5",
      cwd: "C:\\workspace",
    });

    const pending = bridge.sendRequest("codexhost/harness/inspect", {}) as Promise<unknown>;
    void pending.catch(() => undefined);
    const processHandle = (directSend.mock.calls[2]?.[1] as { processHandle: string })
      .processHandle;
    const policy = target.__codexhostDraftPrewarmPolicyV1 as { dispose(): void };
    policy.dispose();

    expect(directSend).toHaveBeenCalledWith("process/kill", { processHandle });
  });

  it("replaces a failed Remote Control bridge process when diagnostics retry", async () => {
    const manager = requestManagerFixture();
    const { bridge, directSend } = remoteRequestBridgeFixture();
    const target: DraftPrewarmPolicyTarget = {};
    installDraftPrewarmPolicyBridge(manager, bridge, "remote-control:fixture-host", target, {
      discardAllPrewarmedThreads: vi.fn(),
    });

    const first = bridge.sendRequest("codexhost/harness/inspect", {}) as Promise<unknown>;
    const firstStart = directSend.mock.calls.find(([method]) => method === "process/spawn");
    const firstProcessHandle = (firstStart?.[1] as { processHandle: string }).processHandle;
    emitBridgeOutput(manager, firstProcessHandle, {
      method: "codexhost/remote-control-bridge/ready",
      params: { protocolVersion: 99 },
    });
    await expect(first).rejects.toThrow("unsupported protocol version");
    expect(directSend).toHaveBeenCalledWith("process/kill", {
      processHandle: firstProcessHandle,
    });

    const second = bridge.sendRequest("codexhost/harness/inspect", {}) as Promise<unknown>;
    void second.catch(() => undefined);
    const starts = directSend.mock.calls.filter(([method]) => method === "process/spawn");
    expect(starts).toHaveLength(2);
    const secondProcessHandle = (starts[1]?.[1] as { processHandle: string }).processHandle;
    expect(secondProcessHandle).not.toBe(firstProcessHandle);

    const policy = target.__codexhostDraftPrewarmPolicyV1 as { dispose(): void };
    policy.dispose();
  });

  it("reports a Remote Control bridge process exit and permits a clean retry", async () => {
    const manager = requestManagerFixture();
    const originalNotification = manager.onNotification as ReturnType<typeof vi.fn>;
    const { bridge, directSend } = remoteRequestBridgeFixture();
    const notifications = remoteNotificationTargetFixture();
    const target = notifications.target;
    installDraftPrewarmPolicyBridge(manager, bridge, "remote-control:fixture-host", target, {
      discardAllPrewarmedThreads: vi.fn(),
    });

    const first = bridge.sendRequest("codexhost/harness/inspect", {}) as Promise<unknown>;
    const firstStart = directSend.mock.calls.find(([method]) => method === "process/spawn");
    const firstProcessHandle = (firstStart?.[1] as { processHandle: string }).processHandle;
    notifications.emit("process/exited", {
      processHandle: firstProcessHandle,
      exitCode: 7,
      stdout: "",
      stdoutCapReached: false,
      stderr: "bridge failed",
      stderrCapReached: false,
    });

    await expect(first).rejects.toThrow("process exited unexpectedly with code 7: bridge failed");
    expect(originalNotification).not.toHaveBeenCalledWith(
      "process/exited",
      expect.objectContaining({ processHandle: firstProcessHandle }),
    );
    expect(directSend).not.toHaveBeenCalledWith("process/kill", {
      processHandle: firstProcessHandle,
    });

    const second = bridge.sendRequest("codexhost/harness/inspect", {}) as Promise<unknown>;
    void second.catch(() => undefined);
    const starts = directSend.mock.calls.filter(([method]) => method === "process/spawn");
    expect(starts).toHaveLength(2);
    expect((starts[1]?.[1] as { processHandle: string }).processHandle).not.toBe(
      firstProcessHandle,
    );

    const policy = target.__codexhostDraftPrewarmPolicyV1 as { dispose(): void };
    policy.dispose();
  });

  it("replaces a Remote Control bridge after writing to a stale process handle", async () => {
    const manager = requestManagerFixture();
    const { bridge, directSend } = remoteRequestBridgeFixture();
    const notifications = remoteNotificationTargetFixture();
    const target = notifications.target;
    installDraftPrewarmPolicyBridge(manager, bridge, "remote-control:fixture-host", target, {
      discardAllPrewarmedThreads: vi.fn(),
    });

    const first = bridge.sendRequest("codexhost/harness/inspect", {}) as Promise<unknown>;
    const firstStart = directSend.mock.calls.find(([method]) => method === "process/spawn");
    const firstProcessHandle = (firstStart?.[1] as { processHandle: string }).processHandle;
    emitRemoteBridgeOutput(notifications, firstProcessHandle, {
      method: "codexhost/remote-control-bridge/ready",
      params: { protocolVersion: 1 },
    });
    await vi.waitFor(() => expect(writtenBridgeFrames(directSend)).toHaveLength(1));
    const initialize = writtenBridgeFrames(directSend)[0];
    emitRemoteBridgeOutput(notifications, firstProcessHandle, { id: initialize?.id, result: {} });
    await vi.waitFor(() => expect(writtenBridgeFrames(directSend)).toHaveLength(3));
    const inspect = writtenBridgeFrames(directSend)[2];
    emitRemoteBridgeOutput(notifications, firstProcessHandle, {
      id: inspect?.id,
      result: { status: "ready" },
    });
    await expect(first).resolves.toEqual({ status: "ready" });

    directSend.mockRejectedValueOnce(
      new Error(`no active process for process handle "${firstProcessHandle}"`),
    );
    const stale = bridge.sendRequest("codexhost/harness/inspect", {}) as Promise<unknown>;
    await expect(stale).rejects.toThrow("no active process for process handle");

    const retry = bridge.sendRequest("codexhost/harness/inspect", {}) as Promise<unknown>;
    void retry.catch(() => undefined);
    const starts = directSend.mock.calls.filter(([method]) => method === "process/spawn");
    expect(starts).toHaveLength(2);
    expect((starts[1]?.[1] as { processHandle: string }).processHandle).not.toBe(
      firstProcessHandle,
    );

    const policy = target.__codexhostDraftPrewarmPolicyV1 as { dispose(): void };
    policy.dispose();
  });

  it("times out a stalled Remote Control initialization and permits a clean retry", async () => {
    vi.useFakeTimers();
    try {
      const manager = requestManagerFixture();
      const { bridge, directSend } = remoteRequestBridgeFixture();
      const notifications = remoteNotificationTargetFixture();
      const target = notifications.target;
      installDraftPrewarmPolicyBridge(manager, bridge, "remote-control:fixture-host", target, {
        discardAllPrewarmedThreads: vi.fn(),
      });

      const first = bridge.sendRequest("codexhost/harness/inspect", {}) as Promise<unknown>;
      const firstRejected = expect(first).rejects.toThrow("initialization timed out after 15000ms");
      const firstStart = directSend.mock.calls.find(([method]) => method === "process/spawn");
      const firstProcessHandle = (firstStart?.[1] as { processHandle: string }).processHandle;
      notifications.emit("process/outputDelta", {
        processHandle: firstProcessHandle,
        stream: "stdout",
        deltaBase64: Buffer.from(
          `${JSON.stringify({
            method: "codexhost/remote-control-bridge/ready",
            params: { protocolVersion: 1 },
          })}\n`,
          "utf8",
        ).toString("base64"),
        capReached: false,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(writtenBridgeFrames(directSend)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(15_000);
      await firstRejected;
      expect(directSend).toHaveBeenCalledWith("process/kill", {
        processHandle: firstProcessHandle,
      });

      const second = bridge.sendRequest("codexhost/harness/inspect", {}) as Promise<unknown>;
      void second.catch(() => undefined);
      const starts = directSend.mock.calls.filter(([method]) => method === "process/spawn");
      expect(starts).toHaveLength(2);
      expect((starts[1]?.[1] as { processHandle: string }).processHandle).not.toBe(
        firstProcessHandle,
      );

      const policy = target.__codexhostDraftPrewarmPolicyV1 as { dispose(): void };
      policy.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("installs the owned request bridge through direct Renderer evaluation", async () => {
    const evaluate = vi.fn(async (expression: string): Promise<unknown> => {
      void expression;
      return {
        state: "ready",
        reason: "owned-request-bridge",
      };
    });
    const renderer = {
      async evaluate<T>(expression: string): Promise<T> {
        return (await evaluate(expression)) as T;
      },
    };

    await expect(installRendererDraftPrewarmPolicyDirect(renderer)).resolves.toEqual({
      state: "ready",
      reason: "owned-request-bridge",
    });
    const expression = evaluate.mock.calls[0]?.[0];
    expect(expression).toContain("document.querySelectorAll");
    expect(expression).toContain("installDraftPrewarmPolicyBridge");
    expect(expression).not.toContain("webContents.fromId");
  });

  it("rejects an invalid Renderer identity before inspecting the Desktop", async () => {
    const evaluate = vi.fn();

    await expect(installRendererDraftPrewarmPolicy({ evaluate }, 0)).rejects.toThrow(
      "Renderer webContents ID must be a positive integer",
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid installation result", async () => {
    const evaluate = vi.fn(async (): Promise<unknown> => {
      return { state: "ready", reason: "ambiguous" };
    });
    const inspector = {
      async evaluate<T>(): Promise<T> {
        return (await evaluate()) as T;
      },
    };

    await expect(installRendererDraftPrewarmPolicy(inspector, 17)).rejects.toThrow(
      "Renderer draft prewarm policy returned an invalid status",
    );
  });

  it("installs on a local split request manager without queue or dispatch surfaces", () => {
    const sendRequest = vi.fn();
    const prewarmThreadStart = vi.fn();
    const bridge: RendererHostRequestBridge = { sendRequest, prewarmThreadStart };
    const manager: RendererHostRequestManager = {};
    const target: DraftPrewarmPolicyTarget = {};
    const prewarmedThreadManager = { discardAllPrewarmedThreads: vi.fn() };

    expect(
      installDraftPrewarmPolicyBridge(manager, bridge, "local", target, prewarmedThreadManager),
    ).toEqual({ state: "ready", reason: "owned-request-bridge" });

    const policy = target.__codexhostDraftPrewarmPolicyV1 as {
      state: string;
      hostId: string;
      select(model: string | null): boolean;
      clear(): Promise<void>;
    };
    expect(policy.state).toBe("ready");
    expect(policy.hostId).toBe("local");

    policy.select("codexhost/claude-code-native");
    void bridge.sendRequest("thread/start", { model: "gpt-5" });
    expect(sendRequest).toHaveBeenCalledWith("thread/start", {
      model: "codexhost/claude-code-native",
    });

    void policy.clear();
    expect(prewarmedThreadManager.discardAllPrewarmedThreads).toHaveBeenCalledOnce();
    expect(manager.onNotification).toBeUndefined();
    expect(manager.dispatchAppServerResponse).toBeUndefined();
  });

  it("reconciles the same local split request manager without reinstalling", () => {
    const bridge: RendererHostRequestBridge = {
      sendRequest: vi.fn(),
      prewarmThreadStart: vi.fn(),
    };
    const manager: RendererHostRequestManager = {};
    const target: DraftPrewarmPolicyTarget = {};
    const prewarmedThreadManager = { discardAllPrewarmedThreads: vi.fn() };

    installDraftPrewarmPolicyBridge(manager, bridge, "local", target, prewarmedThreadManager);
    const first = target.__codexhostDraftPrewarmPolicyV1;
    installDraftPrewarmPolicyBridge(manager, bridge, "local", target, prewarmedThreadManager);
    expect(target.__codexhostDraftPrewarmPolicyV1).toBe(first);
  });
});
