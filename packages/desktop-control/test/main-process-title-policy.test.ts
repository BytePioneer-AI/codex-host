import { describe, expect, it, vi } from "vitest";

import {
  installMainProcessTitlePolicy,
  markRendererTitlePolicyReady,
  readMainProcessTitlePolicyCounters,
} from "../src/main-process-title-policy.js";

function commandSequence(responses: unknown[]) {
  return {
    command: vi.fn(async (...arguments_: [string, Record<string, unknown>?]) => {
      void arguments_;
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected CDP command");
      return response;
    }),
  };
}

describe("main-process title policy", () => {
  it("installs through the connect-app-host listener closure", async () => {
    const inspector = commandSequence([
      { result: { objectId: "listener" } },
      {
        result: [],
        internalProperties: [{ name: "[[Scopes]]", value: { objectId: "scopes" } }],
      },
      { result: [{ name: "0", value: { objectId: "local-scope" } }] },
      { result: [{ name: "f", value: { objectId: "get-context" } }] },
      { result: { objectId: "install-promise" } },
      {
        result: {
          value: {
            state: "ready",
            reason: "ready",
            requiresRendererReload: true,
          },
        },
      },
    ]);

    await expect(installMainProcessTitlePolicy(inspector, 17)).resolves.toEqual({
      state: "ready",
      reason: "ready",
      requiresRendererReload: true,
    });
    expect(inspector.command.mock.calls.map(([method]) => method)).toEqual([
      "Runtime.evaluate",
      "Runtime.getProperties",
      "Runtime.getProperties",
      "Runtime.getProperties",
      "Runtime.callFunctionOn",
      "Runtime.awaitPromise",
    ]);
    expect(inspector.command.mock.calls.at(-2)?.[1]).toMatchObject({
      objectId: "get-context",
      arguments: [{ value: 17 }],
    });
    const functionDeclaration = inspector.command.mock.calls.at(-2)?.[1]?.functionDeclaration;
    expect(functionDeclaration).toContain("webContents.fromId(rendererWebContentsId)");
    expect(functionDeclaration).toContain("ownService(sampleService, selected)");
    expect(functionDeclaration).not.toContain("querySelectorAll('*').length");
    expect(functionDeclaration).not.toContain("constructor?.name");
    expect(inspector.command.mock.calls.at(-1)?.[1]).toEqual({
      promiseObjectId: "install-promise",
      returnByValue: true,
    });
  });

  it("fails closed when the required title service structure is unsupported", async () => {
    const inspector = commandSequence([
      { result: { objectId: "listener" } },
      {
        result: [],
        internalProperties: [{ name: "[[Scopes]]", value: { objectId: "scopes" } }],
      },
      { result: [{ name: "0", value: { objectId: "local-scope" } }] },
      { result: [{ name: "f", value: { objectId: "get-context" } }] },
      { result: { objectId: "install-promise" } },
      {
        exceptionDetails: {
          exception: { description: "ThreadMetadataGenerationService signature mismatch" },
        },
      },
    ]);

    await expect(installMainProcessTitlePolicy(inspector, 17)).rejects.toThrow(
      "ThreadMetadataGenerationService signature mismatch",
    );
  });

  it("fails closed when the listener scope is unavailable", async () => {
    const inspector = commandSequence([
      { result: { objectId: "listener" } },
      { result: [], internalProperties: [] },
    ]);

    await expect(installMainProcessTitlePolicy(inspector, 17)).rejects.toThrow(
      "connect-app-host listener scopes is unavailable",
    );
  });

  it("marks only the selected owned Renderer as ready", async () => {
    const evaluate = vi.fn(async (expression: string) => {
      void expression;
      return {
        state: "ready",
        reason: "owned-metadata-service",
      };
    });
    const inspector = {
      async evaluate<T>(expression: string): Promise<T> {
        return (await evaluate(expression)) as T;
      },
    };

    await expect(markRendererTitlePolicyReady(inspector, 17)).resolves.toEqual({
      state: "ready",
      reason: "owned-metadata-service",
    });
    expect(evaluate).toHaveBeenCalledWith(expect.stringContaining("webContents.fromId(17)"));
    expect(evaluate).not.toHaveBeenCalledWith(expect.stringContaining("querySelectorAll"));
  });

  it("rejects invalid Renderer identities before inspection", async () => {
    const inspector = commandSequence([]);
    const evaluate = vi.fn(async (expression: string) => {
      void expression;
      return null;
    });
    const readinessInspector = {
      async evaluate<T>(expression: string): Promise<T> {
        return (await evaluate(expression)) as T;
      },
    };
    await expect(installMainProcessTitlePolicy(inspector, 0)).rejects.toThrow("positive integer");
    await expect(markRendererTitlePolicyReady(readinessInspector, -1)).rejects.toThrow(
      "positive integer",
    );
    expect(inspector.command).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("reads only sanitized policy counters", async () => {
    const evaluate = vi.fn();
    const inspector = {
      async evaluate<T>(expression: string): Promise<T> {
        evaluate(expression);
        return {
          codexTitleCalls: 2,
          piTitleSkips: 3,
          externalTitleSkips: 4,
          ambiguousTitleSkips: 1,
        } as T;
      },
    };

    await expect(readMainProcessTitlePolicyCounters(inspector)).resolves.toEqual({
      codexTitleCalls: 2,
      piTitleSkips: 3,
      externalTitleSkips: 4,
      ambiguousTitleSkips: 1,
    });
    expect(evaluate).toHaveBeenCalledOnce();
  });
});
