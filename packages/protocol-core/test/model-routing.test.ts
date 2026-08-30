import {
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  type JsonRpcRequest,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_ID,
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_ID,
  GROK_NATIVE_TRANSPORT_MODEL_ID,
  OMP_NATIVE_TRANSPORT_MODEL_ID,
  PI_NATIVE_TRANSPORT_MODEL_ID,
  decodeClaudeTransportSelection,
  decodeAntigravityTransportSelection,
  decodeDeepSeekHarnessTransportSelection,
  decodeCreateRoute,
  decodeExternalTransportModel,
  decodeExternalTransportSelection,
  decodeGrokTransportSelection,
  decodePiTransportModel,
  decodePiTransportSelection,
  encodeClaudeTransportModel,
  encodeAntigravityTransportModel,
  encodeDeepSeekHarnessTransportModel,
  encodeGrokTransportModel,
  encodePiTransportModel,
  encodeOmpTransportModel,
  transportModelIdForHarness,
} from "../src/index.js";

describe("external Harness transport model routing", () => {
  it.each([
    ["pi", PI_NATIVE_TRANSPORT_MODEL_ID],
    ["claude-code", CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID],
    ["deepseek-harness", DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_ID],
    ["grok", GROK_NATIVE_TRANSPORT_MODEL_ID],
    ["omp", OMP_NATIVE_TRANSPORT_MODEL_ID],
    ["antigravity", ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_ID],
  ] as const)("decodes the %s native transport token", (harnessId, transportModelId) => {
    const request: JsonRpcRequest = {
      id: 2,
      method: "thread/start",
      params: { model: transportModelId },
    };
    expect(decodeCreateRoute(request)).toEqual({
      harnessId,
      routeMode: "native",
      transportModelId,
    });
    expect(transportModelIdForHarness(harnessId)).toBe(transportModelId);
  });

  it("keeps official models transparent and ignores other methods", () => {
    expect(
      decodeCreateRoute({ id: 3, method: "thread/start", params: { model: "official/model" } }),
    ).toEqual({ harnessId: "codex", transportModelId: "official/model" });
    expect(decodeCreateRoute({ id: 4, method: "model/list", params: {} })).toBeNull();
  });

  it("round-trips a bounded opaque selected Pi Model Ref", () => {
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.cHJvdmlkZXItaWQ" });
    const transportModelId = encodePiTransportModel(model);

    expect(transportModelId).toBe(`${PI_NATIVE_TRANSPORT_MODEL_ID}@${model.id}`);
    expect(decodePiTransportModel(transportModelId)).toEqual(model);
    expect(
      decodeCreateRoute({
        id: 5,
        method: "thread/start",
        params: { model: transportModelId },
      }),
    ).toEqual({
      harnessId: "pi",
      routeMode: "native",
      transportModelId,
      model,
    });
  });

  it("round-trips an OMP Model and Thinking selection", () => {
    const model = harnessModelRefSchema.parse({ id: "omp-model-v1.b21wZW4" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("high");
    const transportModelId = encodeOmpTransportModel(model, thinkingOptionId);
    expect(
      decodeCreateRoute({ id: 11, method: "thread/start", params: { model: transportModelId } }),
    ).toMatchObject({
      harnessId: "omp",
      model,
      thinkingOptionId,
    });
  });

  it("round-trips an Antigravity Model and Permission Mode", () => {
    const model = harnessModelRefSchema.parse({ id: "gemini-3.7-flash-high" });
    const permissionModeId = harnessPermissionModeIdSchema.parse("configured");
    const transportModelId = encodeAntigravityTransportModel(model, permissionModeId);

    expect(decodeAntigravityTransportSelection(transportModelId)).toEqual({
      model,
      permissionModeId,
    });
    expect(
      decodeCreateRoute({ id: 12, method: "thread/start", params: { model: transportModelId } }),
    ).toMatchObject({ harnessId: "antigravity", model, permissionModeId });
  });

  it("round-trips a request-scoped Pi Model and Thinking pair", () => {
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.cHJvdmlkZXItaWQ" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("xhigh");
    const transportModelId = encodePiTransportModel(model, thinkingOptionId);

    expect(transportModelId).toBe(
      `${PI_NATIVE_TRANSPORT_MODEL_ID}@${model.id}@${thinkingOptionId}`,
    );
    expect(decodePiTransportSelection(transportModelId)).toEqual({
      model,
      thinkingOptionId,
    });
    expect(
      decodeCreateRoute({
        id: 6,
        method: "thread/start",
        params: { model: transportModelId },
      }),
    ).toMatchObject({ harnessId: "pi", model, thinkingOptionId });
  });

  it("round-trips a request-scoped Claude Code Model Ref", () => {
    const model = harnessModelRefSchema.parse({ id: "claude-model-v1.c29ubmV0" });
    const transportModelId = encodeClaudeTransportModel(model);

    expect(transportModelId).toBe(`${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@${model.id}`);
    expect(decodeClaudeTransportSelection(transportModelId)).toEqual({ model });
    expect(
      decodeCreateRoute({
        id: 7,
        method: "thread/start",
        params: { model: transportModelId },
      }),
    ).toEqual({
      harnessId: "claude-code",
      routeMode: "native",
      transportModelId,
      model,
    });
    expect(encodeClaudeTransportModel()).toBe(CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID);
  });

  it("round-trips request-scoped Claude Code Model and Permission Mode", () => {
    const model = harnessModelRefSchema.parse({ id: "claude-model-v1.ZGVmYXVsdA" });
    const permissionModeId = harnessPermissionModeIdSchema.parse("acceptEdits");
    const transportModelId = encodeClaudeTransportModel(model, permissionModeId);

    expect(transportModelId).toBe(
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@${model.id}@${permissionModeId}`,
    );
    expect(decodeClaudeTransportSelection(transportModelId)).toEqual({
      model,
      permissionModeId,
    });
    expect(
      decodeCreateRoute({
        id: 8,
        method: "thread/start",
        params: { model: transportModelId },
      }),
    ).toMatchObject({ harnessId: "claude-code", model, permissionModeId });
    expect(() => encodeClaudeTransportModel(undefined, permissionModeId)).toThrow(
      "requires a Model Ref",
    );
  });

  it("round-trips request-scoped Claude Code Thinking with optional Permission Mode", () => {
    const model = harnessModelRefSchema.parse({ id: "claude-model-v1.ZGVmYXVsdA" });
    const permissionModeId = harnessPermissionModeIdSchema.parse("acceptEdits");
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("xhigh");
    const configured = encodeClaudeTransportModel(model, permissionModeId, thinkingOptionId);
    const withoutPermission = encodeClaudeTransportModel(model, undefined, thinkingOptionId);

    expect(configured).toBe(
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@${model.id}@${permissionModeId}@${thinkingOptionId}`,
    );
    expect(decodeClaudeTransportSelection(configured)).toEqual({
      model,
      permissionModeId,
      thinkingOptionId,
    });
    expect(withoutPermission).toBe(
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@${model.id}@@${thinkingOptionId}`,
    );
    expect(decodeClaudeTransportSelection(withoutPermission)).toEqual({ model, thinkingOptionId });
    expect(
      decodeCreateRoute({ id: 9, method: "thread/start", params: { model: configured } }),
    ).toMatchObject({ harnessId: "claude-code", model, permissionModeId, thinkingOptionId });
  });

  it("round-trips a request-scoped DeepSeek Harness Model Ref", () => {
    const model = harnessModelRefSchema.parse({ id: "deepseek-harness-model-v1.Zmxhc2g" });
    const transportModelId = encodeDeepSeekHarnessTransportModel(model);

    expect(transportModelId).toBe(`${DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_ID}@${model.id}`);
    expect(decodeDeepSeekHarnessTransportSelection(transportModelId)).toEqual({ model });
    expect(
      decodeCreateRoute({ id: 10, method: "thread/start", params: { model: transportModelId } }),
    ).toEqual({
      harnessId: "deepseek-harness",
      routeMode: "native",
      transportModelId,
      model,
    });
  });

  it("round-trips request-scoped Grok Model, Permission Mode, and Thinking selection", () => {
    const model = harnessModelRefSchema.parse({ id: "grok-4.6" });
    const permissionModeId = harnessPermissionModeIdSchema.parse("auto");
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("high");
    const transportModelId = encodeGrokTransportModel(model, permissionModeId, thinkingOptionId);

    expect(transportModelId).toBe(
      `${GROK_NATIVE_TRANSPORT_MODEL_ID}@${model.id}@${permissionModeId}@${thinkingOptionId}`,
    );
    expect(decodeGrokTransportSelection(transportModelId)).toEqual({
      model,
      permissionModeId,
      thinkingOptionId,
    });
    expect(
      decodeCreateRoute({ id: 10, method: "thread/start", params: { model: transportModelId } }),
    ).toMatchObject({ harnessId: "grok", model, permissionModeId, thinkingOptionId });

    const legacyCarrier = `${GROK_NATIVE_TRANSPORT_MODEL_ID}@${model.id}@@${thinkingOptionId}`;
    expect(decodeGrokTransportSelection(legacyCarrier)).toEqual({ model, thinkingOptionId });
  });

  it("decodes existing Thread carriers only for their owning Harness", () => {
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.cHJvdmlkZXItaWQ" });
    const selectedPi = encodePiTransportModel(model);

    expect(decodeExternalTransportModel("pi", PI_NATIVE_TRANSPORT_MODEL_ID)).toBeUndefined();
    expect(decodeExternalTransportModel("pi", selectedPi)).toEqual(model);
    expect(decodeExternalTransportSelection("pi", selectedPi)).toEqual({ model });
    expect(
      decodeExternalTransportModel("claude-code", CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID),
    ).toBeUndefined();
    const selectedClaude = encodeClaudeTransportModel(
      harnessModelRefSchema.parse({ id: "claude-model-v1.c29ubmV0" }),
    );
    expect(decodeExternalTransportModel("claude-code", selectedClaude)).toEqual({
      id: "claude-model-v1.c29ubmV0",
    });
    expect(decodeExternalTransportModel("claude-code", selectedPi)).toBeNull();
    expect(decodeExternalTransportModel("pi", CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID)).toBeNull();
    expect(decodeExternalTransportModel("grok", GROK_NATIVE_TRANSPORT_MODEL_ID)).toBeUndefined();
    expect(decodeExternalTransportModel("grok", selectedPi)).toBeNull();
  });

  it("rejects malformed selected Claude carriers instead of forwarding them as official Models", () => {
    for (const model of [
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@`,
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@provider/model`,
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@${"x".repeat(513)}`,
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@claude-model-v1.valid@provider/mode`,
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@claude-model-v1.valid@default@high@extra`,
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@claude-model-v1.valid@default@`,
    ]) {
      expect(() => decodeCreateRoute({ id: 8, method: "thread/start", params: { model } })).toThrow(
        /invalid Model Ref|invalid Permission Mode|invalid component count|empty Thinking option/u,
      );
    }
    expect(() =>
      decodeExternalTransportModel(
        "claude-code",
        `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@provider/model`,
      ),
    ).toThrow("invalid Model Ref");
  });

  it("rejects malformed selected Pi carriers instead of forwarding them as official Models", () => {
    for (const model of [
      `${PI_NATIVE_TRANSPORT_MODEL_ID}@`,
      `${PI_NATIVE_TRANSPORT_MODEL_ID}@provider/model`,
      `${PI_NATIVE_TRANSPORT_MODEL_ID}@${"x".repeat(513)}`,
      `${PI_NATIVE_TRANSPORT_MODEL_ID}@pi-model-v1.valid@`,
      `${PI_NATIVE_TRANSPORT_MODEL_ID}@pi-model-v1.valid@high@extra`,
    ]) {
      expect(() => decodeCreateRoute({ id: 6, method: "thread/start", params: { model } })).toThrow(
        /invalid Model Ref|empty Thinking option|invalid component count/u,
      );
    }
    expect(decodePiTransportModel("official/model")).toBeNull();
    expect(() =>
      decodeExternalTransportModel("pi", `${PI_NATIVE_TRANSPORT_MODEL_ID}@provider/model`),
    ).toThrow("invalid Model Ref");
    expect(() =>
      encodePiTransportModel(undefined, harnessThinkingOptionIdSchema.parse("high")),
    ).toThrow("requires a Model Ref");
  });
});
