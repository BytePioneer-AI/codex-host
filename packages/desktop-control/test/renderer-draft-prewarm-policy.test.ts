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
    signatureSource?: string;
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
                { name: "sendRequest", value: { objectId: "send-request" } },
              ],
            };
          case "send-request":
            return {
              internalProperties: [{ name: "[[Scopes]]", value: { objectId: "scopes" } }],
            };
          case "scopes":
            return { result: [{ name: "0", value: { objectId: "local-scope" } }] };
          case "local-scope":
            return { result: [{ name: "Rf", value: { objectId: "request-bridge" } }] };
          default:
            throw new Error(`Unexpected Runtime.getProperties object: ${parameters.objectId}`);
        }
      }
      if (method === "Runtime.callFunctionOn") {
        if (String(parameters.functionDeclaration).includes("arity:this.length")) {
          return {
            result: {
              value: {
                arity: 2,
                source:
                  options.signatureSource ??
                  "function Rf(method, params) { return client.sendRequest(method, params); }",
              },
            },
          };
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
    expect(evaluate.mock.calls[0]?.[0]).toContain("webContents.fromId(17)");
  });

  it("executes the CDP traversal and detaches a debugger it attached", async () => {
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
        objectId: "request-bridge",
        functionDeclaration: "function syntheticPolicy() {}",
        arguments: [{ value: "local" }],
      }),
    );
  });

  it.each([
    [{ candidateCount: 2 }, "request manager is ambiguous"],
    [{ hostId: "remote" }, "request manager is ambiguous"],
    [{ signatureSource: "function Rf() {}" }, "signature mismatch"],
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
    const send = vi
      .fn<(method: string, parameters: { hostId: string }) => Promise<undefined>>()
      .mockReturnValueOnce(firstClear.promise)
      .mockResolvedValue(undefined);
    const target: DraftPrewarmPolicyTarget = {};
    installDraftPrewarmPolicyBridge(send, "local", target);
    const policy = target.__codexhostDraftPrewarmPolicyV1 as {
      clear(): Promise<void>;
    };

    const first = policy.clear();
    const concurrent = policy.clear();
    expect(concurrent).toBe(first);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("clear-prewarmed-threads-for-host", { hostId: "local" });

    firstClear.resolve(undefined);
    await first;
    await policy.clear();
    expect(send).toHaveBeenCalledTimes(2);
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
