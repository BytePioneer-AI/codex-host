import { describe, expect, it, vi } from "vitest";

import {
  decorateThreadStartParams,
  findPrewarmTargets,
  isDraftPrewarmPolicyReady,
  isMainProcessTitlePolicyReady,
  modelSelectionForAgent,
  PI_TRANSPORT_MODEL_ID,
  selectOptimisticModelAtom,
  wrapElectronRendererBridge,
  wrapPrewarmDispatcher,
  wrapPrewarmTarget,
} from "../src/index.js";

const lockedPi = {
  agent: "pi",
  composerId: "composer-1",
  phase: "locked",
} as const;

describe("versioned Renderer Agent adapter", () => {
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

  it("creates a Pi optimistic selection and restores the original Codex snapshot", () => {
    const official = { model: "official/model", reasoningEffort: "medium" };

    expect(modelSelectionForAgent(null, "high", "pi")).toEqual({
      model: PI_TRANSPORT_MODEL_ID,
      reasoningEffort: "high",
    });
    expect(modelSelectionForAgent(null, "high", "codex")).toBeNull();
    expect(modelSelectionForAgent(official, "high", "codex")).toBe(official);
  });

  it("clones Pi create params and leaves Codex params unchanged", () => {
    const original = { model: "official/model", cwd: "<workspace>" };

    expect(decorateThreadStartParams(original, lockedPi)).toEqual({
      model: PI_TRANSPORT_MODEL_ID,
      cwd: "<workspace>",
    });
    expect(decorateThreadStartParams(original, lockedPi)).not.toBe(original);
    expect(decorateThreadStartParams(original, null)).toBe(original);
    expect(original.model).toBe("official/model");
  });

  it("prefers an exported instance over its exported prototype", () => {
    class RequestClient {
      prewarmThreadStart(): void {}
    }
    const instance = new RequestClient();

    expect(
      findPrewarmTargets({ instance, RequestClient, unrelated: { sendRequest: vi.fn() } }),
    ).toEqual([instance]);
  });

  it("keeps independent request clients ambiguous", () => {
    const first = { prewarmThreadStart: vi.fn() };
    const second = { prewarmThreadStart: vi.fn() };

    expect(findPrewarmTargets({ first, second })).toEqual([first, second]);
  });

  it("decorates only the active bridge message clone", () => {
    const sendMessageFromView = vi.fn();
    const bridge = { sendMessageFromView };
    const request = {
      id: 7,
      method: "thread/start",
      params: { model: "official/model", cwd: "<workspace>" },
    };
    const message = { type: "send-cli-request-for-host", request };
    const decorated = vi.fn();
    const dispose = wrapElectronRendererBridge(bridge, () => lockedPi, decorated);

    bridge.sendMessageFromView(message);

    expect(sendMessageFromView).toHaveBeenCalledWith({
      type: "send-cli-request-for-host",
      request: {
        id: 7,
        method: "thread/start",
        params: { model: PI_TRANSPORT_MODEL_ID, cwd: "<workspace>" },
      },
    });
    expect(message.request.params.model).toBe("official/model");
    expect(decorated).toHaveBeenCalledOnce();

    dispose();
    expect(bridge.sendMessageFromView).toBe(sendMessageFromView);
  });

  it("decorates only the outbound dispatcher clone", () => {
    const dispatchMessage = vi.fn();
    const dispatcher = { dispatchMessage };
    const request = {
      id: 7,
      method: "thread/start",
      params: { model: "official/model", cwd: "<workspace>" },
    };
    const payload = { request, hostId: "local" };
    const decorated = vi.fn();
    const dispose = wrapPrewarmDispatcher(dispatcher, () => lockedPi, decorated);

    dispatcher.dispatchMessage("thread-prewarm-start", payload);

    expect(dispatchMessage).toHaveBeenCalledWith("thread-prewarm-start", {
      request: {
        id: 7,
        method: "thread/start",
        params: { model: PI_TRANSPORT_MODEL_ID, cwd: "<workspace>" },
      },
      hostId: "local",
    });
    expect(payload.request.params.model).toBe("official/model");
    expect(decorated).toHaveBeenCalledOnce();

    dispose();
    expect(dispatcher.dispatchMessage).toBe(dispatchMessage);
  });

  it("decorates thread/start sent through the generic dispatcher", () => {
    const dispatchMessage = vi.fn();
    const dispatcher = { dispatchMessage };
    const dispose = wrapPrewarmDispatcher(dispatcher, () => lockedPi, vi.fn());

    dispatcher.dispatchMessage("send-cli-request-for-host", {
      request: { method: "thread/start", params: { model: "official/model" } },
    });

    expect(dispatchMessage).toHaveBeenCalledWith("send-cli-request-for-host", {
      request: { method: "thread/start", params: { model: PI_TRANSPORT_MODEL_ID } },
    });
    dispose();
  });

  it("leaves non-create dispatcher messages transparent", () => {
    const dispatchMessage = vi.fn();
    const dispatcher = { dispatchMessage };
    const dispose = wrapPrewarmDispatcher(dispatcher, () => lockedPi, vi.fn());
    const payload = { method: "turn/start" };

    dispatcher.dispatchMessage("send-cli-request-for-host", payload);

    expect(dispatchMessage).toHaveBeenCalledWith("send-cli-request-for-host", payload);
    dispose();
  });

  it("wraps the current call, preserves this, and restores the target", () => {
    const original = vi.fn(function (this: { marker: string }, params: unknown) {
      return { marker: this.marker, params };
    });
    const target = { marker: "client", prewarmThreadStart: original };
    const decorated = vi.fn();
    const dispose = wrapPrewarmTarget(target, () => lockedPi, decorated);

    expect(target.prewarmThreadStart({ model: "official/model", cwd: "<workspace>" })).toEqual({
      marker: "client",
      params: { model: PI_TRANSPORT_MODEL_ID, cwd: "<workspace>" },
    });
    expect(decorated).toHaveBeenCalledOnce();

    dispose();
    expect(target.prewarmThreadStart).toBe(original);
  });

  it("decorates thread/start sent through the active request client", () => {
    const sendRequest = vi.fn();
    const target = { prewarmThreadStart: vi.fn(), sendRequest };
    const params = { model: "official/model", cwd: "<workspace>" };
    const decorated = vi.fn();
    const dispose = wrapPrewarmTarget(target, () => lockedPi, decorated);

    target.sendRequest("thread/start", params, { priority: "critical" });
    target.sendRequest("thread/read", { threadId: "thread-1" });

    expect(sendRequest).toHaveBeenNthCalledWith(
      1,
      "thread/start",
      { model: PI_TRANSPORT_MODEL_ID, cwd: "<workspace>" },
      { priority: "critical" },
    );
    expect(sendRequest).toHaveBeenNthCalledWith(
      2,
      "thread/read",
      { threadId: "thread-1" },
      undefined,
    );
    expect(params.model).toBe("official/model");
    expect(decorated).toHaveBeenCalledOnce();

    dispose();
    expect(target.sendRequest).toBe(sendRequest);
  });

  it("passes Codex calls through with the original params object", () => {
    const original = vi.fn();
    const target = { prewarmThreadStart: original };
    const params = { model: "official/model", cwd: "<workspace>" };
    const decorated = vi.fn();
    const dispose = wrapPrewarmTarget(
      target,
      () => ({ agent: "codex", composerId: "composer-1", phase: "locked" }),
      decorated,
    );

    target.prewarmThreadStart(params);

    expect(original).toHaveBeenCalledWith(params, undefined);
    expect(decorated).not.toHaveBeenCalled();
    dispose();
  });

  it("does not decorate when the Composer association is ambiguous", () => {
    const original = vi.fn();
    const target = { prewarmThreadStart: original };
    const params = { model: "official/model" };
    const dispose = wrapPrewarmTarget(target, () => null, vi.fn());

    target.prewarmThreadStart(params);

    expect(original).toHaveBeenCalledWith(params, undefined);
    dispose();
  });

  it("fails closed on an invalid create shape", () => {
    expect(() => decorateThreadStartParams({ cwd: "<workspace>" }, lockedPi)).toThrow(
      "thread/start params must contain a text Model",
    );
  });
});
