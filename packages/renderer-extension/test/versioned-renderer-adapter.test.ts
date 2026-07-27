import { describe, expect, it, vi } from "vitest";

import {
  decorateThreadStartParams,
  findPrewarmTargets,
  PI_TRANSPORT_MODEL_ID,
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

  it("fails closed on an invalid create shape", () => {
    expect(() => decorateThreadStartParams({ cwd: "<workspace>" }, lockedPi)).toThrow(
      "thread/start params must contain a text Model",
    );
  });
});
