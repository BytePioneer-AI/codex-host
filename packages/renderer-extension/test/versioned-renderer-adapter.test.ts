import {
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  CLAUDE_CODE_TRANSPORT_MODEL_ID,
  claudeTransportModelId,
  decodeClaudeTransportModelId,
  findActivePrewarmTargets,
  isClaudeTransportModelId,
  isDraftPrewarmPolicyReady,
  isMainProcessTitlePolicyReady,
  isPiTransportModelId,
  modelSelectionForAgent,
  piTransportModelId,
  PI_TRANSPORT_MODEL_ID,
  sameModelPowerSelection,
  selectOptimisticModelAtom,
  threadIdFromComposerModelTarget,
} from "../src/index.js";

describe("versioned Renderer Agent adapter", () => {
  it("finds only current-build request clients from the active Composer Fiber", () => {
    const editor = {
      parentElement: null,
      querySelectorAll: () => [],
    } as unknown as Element;
    const root = { querySelector: () => editor } as unknown as ParentNode;
    const nestedClient = {
      prewarmThreadStart: function prewarmThreadStart() {
        return "prewarm-thread-start-for-host";
      },
    };
    const manager = {
      requestClient: nestedClient,
      sendRequest: function sendRequest() {
        return "send-cli-request-for-host";
      },
    };
    Object.defineProperty(editor, "__reactFiber$test", {
      configurable: true,
      value: { memoizedState: { memoizedState: manager, next: null }, return: null },
    });

    expect(findActivePrewarmTargets(root)).toEqual([manager]);

    const directClient = {
      prewarmThreadStart: function prewarmThreadStart() {
        const enqueueRequest = "enqueueRequest";
        return `${enqueueRequest}:thread-prewarm-start`;
      },
    };
    Object.defineProperty(editor, "__reactFiber$test", {
      configurable: true,
      value: {
        memoizedState: { memoizedState: { requestClient: directClient }, next: null },
        return: null,
      },
    });

    expect(findActivePrewarmTargets(root)).toEqual([directClient]);
  });

  it("selects one optimistic Model atom from equivalent Fiber cache copies", () => {
    const optimistic = { atom: {}, get: vi.fn(() => null), set: vi.fn() };
    const committed = { atom: {}, get: vi.fn(() => null), set: vi.fn() };
    const firstTarget = ["conversation", "opaque-id"];
    const secondTarget = [...firstTarget];

    expect(
      selectOptimisticModelAtom([
        { optimistic, committed, target: firstTarget },
        { optimistic, committed, target: secondTarget },
      ]),
    ).toBe(optimistic);
    expect(
      selectOptimisticModelAtom([
        { optimistic, committed, target: firstTarget },
        {
          optimistic: { atom: {}, get: vi.fn(() => null), set: vi.fn() },
          committed,
          target: secondTarget,
        },
      ]),
    ).toBeNull();
  });

  it("requires both version policy readiness markers", () => {
    expect(isMainProcessTitlePolicyReady({ state: "ready" })).toBe(true);
    expect(isMainProcessTitlePolicyReady({ state: "installing" })).toBe(false);
    expect(isMainProcessTitlePolicyReady(null)).toBe(false);
    expect(isDraftPrewarmPolicyReady({ state: "ready", clear: vi.fn() })).toBe(true);
    expect(isDraftPrewarmPolicyReady({ state: "ready" })).toBe(false);
    expect(isDraftPrewarmPolicyReady(null)).toBe(false);
  });

  it("compares Model power selections before writing the optimistic atom", () => {
    const selected = { model: "external/model", reasoningEffort: "medium" };

    expect(sameModelPowerSelection(selected, selected)).toBe(true);
    expect(sameModelPowerSelection(selected, { ...selected })).toBe(true);
    expect(sameModelPowerSelection(null, null)).toBe(true);
    expect(sameModelPowerSelection(selected, null)).toBe(false);
    expect(sameModelPowerSelection(selected, { ...selected, reasoningEffort: "high" })).toBe(false);
    expect(sameModelPowerSelection(selected, { ...selected, model: "other/model" })).toBe(false);
  });

  it("creates external optimistic selections and restores the original Codex snapshot", () => {
    const official = { model: "official/model", reasoningEffort: "medium" };

    expect(modelSelectionForAgent(null, "high", "pi")).toEqual({
      model: PI_TRANSPORT_MODEL_ID,
      reasoningEffort: "high",
    });
    expect(modelSelectionForAgent(null, "high", "claude-code")).toEqual({
      model: CLAUDE_CODE_TRANSPORT_MODEL_ID,
      reasoningEffort: "high",
    });
    expect(modelSelectionForAgent(null, "high", "codex")).toBeNull();
    expect(modelSelectionForAgent(official, "high", "codex")).toBe(official);
  });

  it("encodes selected Pi Model and Thinking in the internal carrier", () => {
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.synthetic" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("xhigh");
    const selected = piTransportModelId(model, thinkingOptionId);

    expect(selected).toBe(`${PI_TRANSPORT_MODEL_ID}@${model.id}@${thinkingOptionId}`);
    expect(isPiTransportModelId(selected)).toBe(true);
    expect(isPiTransportModelId(`${PI_TRANSPORT_MODEL_ID}@provider/model`)).toBe(false);
    expect(modelSelectionForAgent(null, "high", "pi", model, thinkingOptionId)).toEqual({
      model: selected,
      reasoningEffort: "high",
    });
  });

  it("encodes selected Claude Model, Thinking, and optional Permission Mode", () => {
    const model = harnessModelRefSchema.parse({ id: "claude-model-v1.c29ubmV0" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("xhigh");
    const permissionModeId = harnessPermissionModeIdSchema.parse("acceptEdits");
    const selected = claudeTransportModelId(model);
    const permissionOnly = claudeTransportModelId(model, permissionModeId);
    const configured = claudeTransportModelId(model, permissionModeId, thinkingOptionId);

    expect(selected).toBe(`${CLAUDE_CODE_TRANSPORT_MODEL_ID}@${model.id}`);
    expect(permissionOnly).toBe(`${selected}@${permissionModeId}`);
    expect(configured).toBe(`${permissionOnly}@${thinkingOptionId}`);
    expect(isClaudeTransportModelId(selected)).toBe(true);
    expect(isClaudeTransportModelId(permissionOnly)).toBe(true);
    expect(isClaudeTransportModelId(configured)).toBe(true);
    expect(decodeClaudeTransportModelId(configured)).toEqual({
      model,
      thinkingOptionId,
      permissionModeId,
    });
    expect(isClaudeTransportModelId(`${configured}@extra`)).toBe(false);
    expect(isClaudeTransportModelId(`${selected}@provider/mode`)).toBe(false);
    expect(
      modelSelectionForAgent(
        null,
        "high",
        "claude-code",
        model,
        thinkingOptionId,
        permissionModeId,
      ),
    ).toEqual({
      model: configured,
      reasoningEffort: "high",
    });
  });

  it("extracts only a validated conversation Thread identity", () => {
    expect(threadIdFromComposerModelTarget(["conversation", "thread-1"])).toBe("thread-1");
    expect(threadIdFromComposerModelTarget(["default", "thread-1"])).toBeNull();
    expect(threadIdFromComposerModelTarget(["conversation", ""])).toBeNull();
    expect(threadIdFromComposerModelTarget(["conversation", {}])).toBeNull();
  });
});
