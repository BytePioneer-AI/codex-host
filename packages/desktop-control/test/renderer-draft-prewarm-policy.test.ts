import { describe, expect, it, vi } from "vitest";

import { installRendererDraftPrewarmPolicy } from "../src/renderer-draft-prewarm-policy.js";
import {
  installDraftPrewarmPolicyBridge,
  installDraftPrewarmPolicyInRenderer,
  type DraftPrewarmPolicyTarget,
  type RendererDebugger,
  type RendererWebContents,
} from "../src/renderer-draft-prewarm-runtime.js";

function rendererFixture(
  options: {
    candidateCount?: number;
    hostId?: string;
    hostBridgeCandidates?: number;
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
                { name: "manager", value: { objectId: "request-manager" } },
                { name: "prewarmedThreadManager", value: { objectId: "prewarm-manager" } },
              ],
            };
          case "request-manager":
            return {
              result: [],
              internalProperties: [
                { name: "[[Prototype]]", value: { objectId: "manager-prototype" } },
              ],
            };
          case "manager-prototype":
            return {
              result: [{ name: "sendRequest", value: { objectId: "manager-send-request" } }],
            };
          case "manager-send-request":
            return {
              internalProperties: [{ name: "[[Scopes]]", value: { objectId: "scopes" } }],
            };
          case "scopes":
            return { result: [{ value: { objectId: "module-scope" } }] };
          case "module-scope":
            return {
              result: Array.from({ length: options.hostBridgeCandidates ?? 1 }, (_, index) => ({
                name: `bridge-${index}`,
                value: { objectId: `host-bridge-${index}`, type: "object" },
              })),
            };
          default:
            throw new Error(`Unexpected Runtime.getProperties object: ${parameters.objectId}`);
        }
      }
      if (method === "Runtime.callFunctionOn") {
        if (String(parameters.functionDeclaration).includes("messageHandler")) {
          return { result: { value: true } };
        }
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
    expect(expression).toContain("typeof value.requestClient.enqueueRequest === 'function'");
    expect(expression).not.toContain(
      "Function.prototype.toString.call(value.sendRequest).includes(\n          'send-cli-request-for-host',\n        )",
    );
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
        objectId: "host-bridge-0",
        functionDeclaration: "function syntheticPolicy() {}",
        arguments: [{ value: "local" }, { objectId: "prewarm-manager" }],
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
        objectId: "host-bridge-0",
        arguments: [{ value: "remote-ssh-discovered:mac" }, { objectId: "prewarm-manager" }],
      }),
    );
  });

  it.each([
    [{ candidateCount: 2 }, "request manager is ambiguous"],
    [{ hostId: "" }, "request manager is ambiguous"],
    [{ hostBridgeCandidates: 0 }, "Host request bridge is ambiguous"],
    [{ hostBridgeCandidates: 2 }, "Host request bridge is ambiguous"],
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

  it("coalesces concurrent clear operations and allows a later clear", async () => {
    const firstClear = Promise.withResolvers<undefined>();
    const sendRequest = vi
      .fn<(method: string, parameters: { hostId: string }) => Promise<undefined>>()
      .mockReturnValueOnce(firstClear.promise)
      .mockResolvedValue(undefined);
    const target: DraftPrewarmPolicyTarget = {};
    installDraftPrewarmPolicyBridge({ sendRequest }, "local", target);
    const policy = target.__codexhostDraftPrewarmPolicyV1 as {
      clear(): Promise<void>;
    };

    const first = policy.clear();
    const concurrent = policy.clear();
    expect(concurrent).toBe(first);
    expect(sendRequest).toHaveBeenCalledOnce();
    expect(sendRequest).toHaveBeenCalledWith("clear-prewarmed-threads-for-host", {
      hostId: "local",
    });

    firstClear.resolve(undefined);
    await first;
    await policy.clear();
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it("uses the current prewarmed Thread manager when available", async () => {
    const discardAllPrewarmedThreads = vi.fn();
    const sendRequest = vi.fn();
    const target: DraftPrewarmPolicyTarget = {};
    installDraftPrewarmPolicyBridge({ sendRequest }, "local", target, {
      discardAllPrewarmedThreads,
    });
    const policy = target.__codexhostDraftPrewarmPolicyV1 as { clear(): Promise<void> };

    await policy.clear();

    expect(discardAllPrewarmedThreads).toHaveBeenCalledOnce();
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("keeps the selected route when the same Host bridge is reconciled", () => {
    const sendRequest = vi.fn();
    const bridge = { sendRequest };
    const target: DraftPrewarmPolicyTarget = {};
    installDraftPrewarmPolicyBridge(bridge, "remote-ssh-discovered:mac", target);
    const first = target.__codexhostDraftPrewarmPolicyV1 as {
      hostId: string;
      select(model: string | null): boolean;
    };
    first.select("codexhost/claude-code-native");

    installDraftPrewarmPolicyBridge(bridge, "remote-ssh-discovered:mac", target);

    expect(target.__codexhostDraftPrewarmPolicyV1).toBe(first);
    expect(first.hostId).toBe("remote-ssh-discovered:mac");
    void bridge.sendRequest("thread/start", { model: "gpt-5" });
    expect(sendRequest).toHaveBeenCalledWith("thread/start", {
      model: "codexhost/claude-code-native",
    });
  });

  it("routes direct and prewarmed creates through the selected transport Model", async () => {
    const sendRequest = vi.fn<(method: string, parameters: unknown) => Promise<void>>(
      async () => undefined,
    );
    const bridge = { sendRequest };
    const target: DraftPrewarmPolicyTarget = {};
    installDraftPrewarmPolicyBridge(bridge, "local", target);
    const policy = target.__codexhostDraftPrewarmPolicyV1 as {
      select(model: string | null): boolean;
    };

    policy.select("codexhost/pi-native");
    await bridge.sendRequest("start-conversation", {
      collaborationMode: { mode: "default", settings: { model: "codexhost/grok-native" } },
    });
    await bridge.sendRequest("prewarm-thread-start-for-host", {
      hostId: "local",
      params: { model: "codexhost/grok-native" },
    });

    expect(sendRequest).toHaveBeenNthCalledWith(1, "start-conversation", {
      collaborationMode: { mode: "default", settings: { model: "codexhost/pi-native" } },
    });
    expect(sendRequest).toHaveBeenNthCalledWith(2, "prewarm-thread-start-for-host", {
      hostId: "local",
      params: { model: "codexhost/pi-native" },
    });
  });

  it("routes the current request client's direct and prewarm Thread starts", async () => {
    const sendRequest = vi.fn<(method: string, parameters: unknown) => Promise<void>>(
      async () => undefined,
    );
    const prewarmThreadStart = vi.fn(async (parameters: unknown) => parameters);
    const bridge = { sendRequest, prewarmThreadStart };
    const target: DraftPrewarmPolicyTarget = {};
    installDraftPrewarmPolicyBridge(bridge, "local", target);
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
});
