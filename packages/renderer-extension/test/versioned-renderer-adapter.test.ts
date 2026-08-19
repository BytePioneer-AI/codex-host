import {
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  CLAUDE_CODE_TRANSPORT_MODEL_ID,
  DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID,
  GROK_TRANSPORT_MODEL_ID,
  PI_TRANSPORT_MODEL_ID,
  claudeTransportModelId,
  decodeClaudeTransportModelId,
  findActivePrewarmTargets,
  findComposerModelTarget,
  isClaudeTransportModelId,
  isDraftPrewarmPolicyReady,
  isMainProcessTitlePolicyReady,
  modelSelectionForAgent,
  piTransportModelId,
  threadIdFromComposerModelTarget,
} from "../src/index.js";
import { transitionRendererAdapterStatus } from "../src/versioned-renderer-adapter.js";

function composerWithFiber(fiber: object): Element {
  const composer = { matches: () => true, parentElement: null } as unknown as Element;
  Object.defineProperty(composer, "__reactFiber$test", {
    configurable: true,
    value: fiber,
  });
  return composer;
}

describe("current Codex Renderer Agent adapter", () => {
  it("publishes only semantic Adapter status transitions", () => {
    const status = {
      state: "installing" as const,
      reason: "installing" as const,
      modelUpdates: 0,
      hook: null,
    };
    const publish = vi.fn();
    const ready = {
      state: "ready" as const,
      reason: "ready" as const,
      hook: "request-bridge" as const,
    };

    expect(transitionRendererAdapterStatus(status, ready, publish)).toBe(true);
    expect(transitionRendererAdapterStatus(status, ready, publish)).toBe(false);
    expect(status).toEqual({ ...ready, modelUpdates: 0 });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("finds the current request manager from the active Composer Fiber", () => {
    const editor = {
      parentElement: null,
      querySelectorAll: () => [],
    } as unknown as Element;
    const root = { querySelector: () => editor } as unknown as ParentNode;
    const manager = {
      requestClient: {
        prewarmThreadStart: function prewarmThreadStart() {
          return "prewarm-thread-start-for-host";
        },
      },
      sendRequest: function sendRequest() {
        return "send-cli-request-for-host";
      },
    };
    Object.defineProperty(editor, "__reactFiber$test", {
      configurable: true,
      value: { memoizedState: { memoizedState: manager, next: null }, return: null },
    });

    expect(findActivePrewarmTargets(root)).toEqual([manager]);
  });

  it("keeps the outer manager so Usage notifications stay attached after wrapping", () => {
    const editor = {
      parentElement: null,
      querySelectorAll: () => [],
    } as unknown as Element;
    const root = { querySelector: () => editor } as unknown as ParentNode;
    const addNotificationCallback = vi.fn(() => () => undefined);
    const requestClient = {
      hostId: "local",
      sendRequest: vi.fn<(method: string, params: unknown) => void>(),
      prewarmThreadStart: () => undefined,
      enqueueRequest: () => undefined,
    };
    const manager = {
      requestClient,
      sendRequest: async (method: string, params: unknown) =>
        requestClient.sendRequest(method, params),
      addNotificationCallback,
    };
    Object.defineProperty(editor, "__reactFiber$test", {
      configurable: true,
      value: { memoizedState: { memoizedState: manager, next: null }, return: null },
    });

    expect(findActivePrewarmTargets(root)).toEqual([manager]);
    expect(findActivePrewarmTargets(root)[0]?.addNotificationCallback).toBe(
      addNotificationCallback,
    );
  });

  it("finds the current seven-slot new Thread draft identity", () => {
    const wrapper = { isManuallyChanged: false, modelSettings: null, serviceTier: null };
    const draftAtom = { get: vi.fn(() => wrapper) };
    const composer = composerWithFiber({
      updateQueue: {
        memoCache: {
          data: [
            [
              {},
              { resolve: vi.fn(), scope: {}, kind: "value", read: vi.fn() },
              "client-new-thread:opaque",
              draftAtom,
              undefined,
              draftAtom,
              draftAtom,
            ],
          ],
        },
      },
      return: null,
    });

    expect(findComposerModelTarget(composer)).toEqual(["default", "client-new-thread:opaque"]);
  });

  it("uses the current Composer conversation identity", () => {
    const composer = composerWithFiber({
      memoizedProps: { conversationId: "thread-1" },
      return: null,
    });

    expect(findComposerModelTarget(composer)).toEqual(["conversation", "thread-1"]);
  });

  it("fails closed for ambiguous current identities", () => {
    const wrapper = { isManuallyChanged: false, modelSettings: null };
    const draftAtom = { get: vi.fn(() => wrapper) };
    const composer = composerWithFiber({
      updateQueue: {
        memoCache: {
          data: [
            [{}, {}, "client-new-thread:first", draftAtom, undefined, draftAtom, draftAtom],
            [{}, {}, "client-new-thread:second", draftAtom, undefined, draftAtom, draftAtom],
          ],
        },
      },
      return: null,
    });
    const conflictingConversation = composerWithFiber({
      memoizedProps: { conversationId: "thread-1" },
      return: { memoizedProps: { conversationId: "thread-2" }, return: null },
    });

    expect(findComposerModelTarget(composer)).toBeNull();
    expect(findComposerModelTarget(conflictingConversation)).toBeNull();
  });

  it("requires both current-version policy readiness markers", () => {
    expect(isMainProcessTitlePolicyReady({ state: "ready" })).toBe(true);
    expect(isMainProcessTitlePolicyReady({ state: "installing" })).toBe(false);
    expect(isDraftPrewarmPolicyReady({ state: "ready", select: vi.fn(), clear: vi.fn() })).toBe(
      true,
    );
    expect(isDraftPrewarmPolicyReady({ state: "ready", clear: vi.fn() })).toBe(false);
  });

  it("creates base transport selections and clears routing for Codex", () => {
    expect(modelSelectionForAgent(null, null, "pi")?.model).toBe(PI_TRANSPORT_MODEL_ID);
    expect(modelSelectionForAgent(null, null, "claude-code")?.model).toBe(
      CLAUDE_CODE_TRANSPORT_MODEL_ID,
    );
    expect(modelSelectionForAgent(null, null, "deepseek-harness")?.model).toBe(
      DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID,
    );
    expect(modelSelectionForAgent(null, null, "grok")?.model).toBe(GROK_TRANSPORT_MODEL_ID);
    expect(modelSelectionForAgent(null, null, "codex")).toBeNull();
  });

  it("encodes selected Pi Model and Thinking in the transport carrier", () => {
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.synthetic" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("xhigh");

    expect(piTransportModelId(model, thinkingOptionId)).toBe(
      `${PI_TRANSPORT_MODEL_ID}@${model.id}@${thinkingOptionId}`,
    );
    expect(modelSelectionForAgent(null, null, "pi", model, thinkingOptionId)?.model).toBe(
      `${PI_TRANSPORT_MODEL_ID}@${model.id}@${thinkingOptionId}`,
    );
  });

  it("encodes Claude Model, Permission Mode, and Thinking in the transport carrier", () => {
    const model = harnessModelRefSchema.parse({ id: "claude-model-v1.c29ubmV0" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("xhigh");
    const permissionModeId = harnessPermissionModeIdSchema.parse("acceptEdits");
    const carrier = claudeTransportModelId(model, permissionModeId, thinkingOptionId);

    expect(isClaudeTransportModelId(carrier)).toBe(true);
    expect(decodeClaudeTransportModelId(carrier)).toEqual({
      model,
      thinkingOptionId,
      permissionModeId,
    });
    expect(
      modelSelectionForAgent(null, null, "claude-code", model, thinkingOptionId, permissionModeId)
        ?.model,
    ).toBe(carrier);
  });

  it("extracts only a validated conversation Thread identity", () => {
    expect(threadIdFromComposerModelTarget(["conversation", "thread-1"])).toBe("thread-1");
    expect(threadIdFromComposerModelTarget(["default", "thread-1"])).toBeNull();
    expect(threadIdFromComposerModelTarget(["conversation", ""])).toBeNull();
  });
});
