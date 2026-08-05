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
            contextClass: "WindowContext",
            serviceClass: "ThreadMetadataGenerationService",
            requiresRendererReload: true,
          },
        },
      },
    ]);

    await expect(installMainProcessTitlePolicy(inspector)).resolves.toEqual({
      state: "ready",
      reason: "ready",
      contextClass: "WindowContext",
      serviceClass: "ThreadMetadataGenerationService",
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
    });
    const functionDeclaration = inspector.command.mock.calls.at(-2)?.[1]?.functionDeclaration;
    expect(functionDeclaration).toContain("ownService(sampleService, selected)");
    expect(functionDeclaration).toContain("['Dhe', 'Nye', 'wbe']");
    expect(inspector.command.mock.calls.at(-1)?.[1]).toEqual({
      promiseObjectId: "install-promise",
      returnByValue: true,
    });
  });

  it("fails closed when the listener scope is unavailable", async () => {
    const inspector = commandSequence([
      { result: { objectId: "listener" } },
      { result: [], internalProperties: [] },
    ]);

    await expect(installMainProcessTitlePolicy(inspector)).rejects.toThrow(
      "connect-app-host listener scopes is unavailable",
    );
  });

  it("marks only a Renderer with an owned metadata service as ready", async () => {
    const inspector = {
      async evaluate<T>(): Promise<T> {
        return { state: "ready", reason: "owned-metadata-service" } as T;
      },
    };

    await expect(markRendererTitlePolicyReady(inspector)).resolves.toEqual({
      state: "ready",
      reason: "owned-metadata-service",
    });
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
