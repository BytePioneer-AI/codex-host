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
            warnings: [],
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
      warnings: [],
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
    expect(functionDeclaration).toContain('["Dhe","Nye","wbe","nxe"].includes(serviceClass)');
    expect(functionDeclaration).toContain("reason: 'unreviewed-title-service-identity'");
    expect(functionDeclaration).not.toContain("constructor?.name) ||");
    expect(inspector.command.mock.calls.at(-1)?.[1]).toEqual({
      promiseObjectId: "install-promise",
      returnByValue: true,
    });
  });

  it("returns a bounded warning for an unreviewed service identity", async () => {
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
            contextClass: "FutureContext",
            serviceClass: "FutureTitleService",
            requiresRendererReload: true,
            warnings: [
              {
                capability: "title-isolation",
                reason: "unreviewed-title-service-identity",
                observedIdentity: "FutureTitleService",
              },
            ],
          },
        },
      },
    ]);

    await expect(installMainProcessTitlePolicy(inspector)).resolves.toMatchObject({
      state: "ready",
      warnings: [
        {
          capability: "title-isolation",
          reason: "unreviewed-title-service-identity",
          observedIdentity: "FutureTitleService",
        },
      ],
    });
  });

  it("rejects malformed or unbounded compatibility warnings", async () => {
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
            contextClass: "FutureContext",
            serviceClass: "FutureTitleService",
            requiresRendererReload: true,
            warnings: [
              {
                capability: "title-isolation",
                reason: "unreviewed-title-service-identity",
                observedIdentity: "unsafe identity with spaces",
              },
            ],
          },
        },
      },
    ]);

    await expect(installMainProcessTitlePolicy(inspector)).rejects.toThrow("invalid status");
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

    await expect(installMainProcessTitlePolicy(inspector)).rejects.toThrow(
      "ThreadMetadataGenerationService signature mismatch",
    );
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
