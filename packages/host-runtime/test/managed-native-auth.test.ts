import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import { UnavailableCodexAccounts } from "../src/account/codex-account-control.js";
import type {
  NativeChatgptLogin,
  NativeChatgptLoginParams,
} from "../src/account/native-chatgpt-login.js";
import { OfficialWorkGate } from "../src/codex-runtime/official-work-gate.js";
import { ManagedNativeAuth } from "../src/managed-native-auth.js";

const bridges = new Set<ManagedNativeAuth>();
afterEach(() => {
  for (const bridge of bridges) bridge.close();
  bridges.clear();
});

function login(): NativeChatgptLogin {
  return {
    response: {
      type: "chatgpt",
      loginId: "operation",
      authUrl: "https://auth.openai.com/authorize?synthetic=1",
    },
    completed: Promise.resolve({
      loginId: "operation",
      success: true,
      error: null,
      onboardingEntrypoint: "life_sciences",
    }),
  };
}
function fixture() {
  const gate = new OfficialWorkGate();
  gate.initialized();
  const controlRequest = vi.fn<(method: string, params: JsonObject) => Promise<JsonObject>>(
    async () => ({
      result: { account: { type: "chatgpt", email: "synthetic@example.test", planType: "pro" } },
    }),
  );
  const scope = { gate, closed: false, owner: { generation: 1, running: true, controlRequest } };
  const control = Object.assign(new UnavailableCodexAccounts(), {
    startNativeLogin: vi.fn<(params: NativeChatgptLoginParams) => Promise<NativeChatgptLogin>>(
      async () => login(),
    ),
    cancelLogin: vi.fn<(loginId: string) => Promise<boolean>>(async () => true),
    logout: vi.fn(async () => {}),
  });
  const events: string[] = [];
  const notify = vi.fn<(method: string, params: JsonObject) => Promise<void>>(async (method) => {
    events.push(method);
  });
  const diagnose = vi.fn();
  const bridge = new ManagedNativeAuth({ scope, control, notify, diagnose });
  bridges.add(bridge);
  return { bridge, scope, control, controlRequest, notify, diagnose, events };
}

describe("managed native authentication protocol delivery", () => {
  it("delivers early completion only after the native start response is written", async () => {
    const f = fixture();
    const written = Promise.withResolvers<undefined>();
    const respond = vi.fn<(result: JsonObject) => Promise<void>>(async () => {
      f.events.push("response-start");
      await written.promise;
      f.events.push("response-written");
    });
    const params = { type: "chatgpt", codexStreamlinedLogin: true, appBrand: "codex" };
    const request = f.bridge.request("account/login/start", params, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    expect(f.notify).not.toHaveBeenCalled();
    written.resolve(undefined);
    await request;
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
    expect(f.control.startNativeLogin).toHaveBeenCalledWith(params);
    expect(f.events).toEqual(["response-start", "response-written", "account/login/completed"]);
    expect(f.notify).toHaveBeenCalledWith("account/login/completed", {
      loginId: "operation",
      success: true,
      error: null,
      onboardingEntrypoint: "life_sciences",
    });
  });

  it("uses native cancellation statuses rather than the Host Settings boolean response", async () => {
    const f = fixture();
    f.control.cancelLogin.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const respond = vi.fn<(result: JsonObject) => Promise<void>>(async () => {});
    await f.bridge.request("account/login/cancel", { loginId: "operation" }, respond);
    await f.bridge.request("account/login/cancel", { loginId: "already-finished" }, respond);
    expect(respond.mock.calls).toEqual([[{ status: "canceled" }], [{ status: "notFound" }]]);
  });

  it("does not read or announce a staging account, including after Host-only initialize", async () => {
    const f = fixture();
    f.bridge.initialized(1);
    expect(f.controlRequest).not.toHaveBeenCalled();
    const change = f.scope.gate.beginChange();
    f.scope.owner.generation = 2; // staging
    f.bridge.initialized(undefined);
    await Promise.resolve();
    expect(f.controlRequest).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
    f.scope.owner.generation = 3; // permanent, verified by the Account coordinator
    change.finish("ready");
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
    expect(f.controlRequest).toHaveBeenCalledWith("account/read", { refreshToken: false });
    expect(f.notify).toHaveBeenCalledWith("account/updated", {
      authMode: "chatgpt",
      planType: "pro",
    });
    const metadataOnly = f.scope.gate.beginChange();
    metadataOnly.finish("ready");
    await Promise.resolve();
    expect(f.controlRequest).toHaveBeenCalledOnce();
  });

  it("does not let an account-updated notification overtake a slow native start reply", async () => {
    const f = fixture();
    f.bridge.initialized(1);
    f.control.startNativeLogin.mockImplementation(async () => {
      const change = f.scope.gate.beginChange();
      f.scope.owner.generation = 3;
      change.finish("ready");
      return login();
    });
    const written = Promise.withResolvers<undefined>();
    const respond = vi.fn<(result: JsonObject) => Promise<void>>(async () => {
      await written.promise;
      f.events.push("response-written");
    });
    const request = f.bridge.request("account/login/start", { type: "chatgpt" }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    expect(f.controlRequest).not.toHaveBeenCalled();
    expect(f.scope.gate.busy).toBe(false);
    written.resolve(undefined);
    await request;
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledTimes(2));
    expect(f.events).toEqual(["response-written", "account/login/completed", "account/updated"]);
  });

  it("discards a retired generation without blocking another Account operation", async () => {
    const f = fixture();
    const old = Promise.withResolvers<JsonObject>();
    f.controlRequest.mockImplementationOnce(() => old.promise);
    f.bridge.initialized(undefined);
    await vi.waitFor(() => expect(f.controlRequest).toHaveBeenCalledOnce());
    const change = f.scope.gate.beginChange();
    f.scope.owner.generation = 2;
    change.finish("ready");
    old.resolve({ result: { account: null } });
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
    expect(f.controlRequest).toHaveBeenCalledTimes(2);
    expect(f.notify).toHaveBeenCalledWith("account/updated", {
      authMode: "chatgpt",
      planType: "pro",
    });
  });

  it("isolates notification failure without retry loops or changing readiness", async () => {
    const f = fixture();
    f.controlRequest.mockResolvedValue({
      error: { code: -1, message: "synthetic private diagnostic" },
    });
    f.bridge.initialized(undefined);
    await vi.waitFor(() => expect(f.diagnose).toHaveBeenCalledOnce());
    expect(f.controlRequest).toHaveBeenCalledOnce();
    expect(f.diagnose).toHaveBeenCalledWith();
    expect(f.scope.gate.phase).toBe("ready");
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("never publishes a late account result after the Desktop client closes", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<JsonObject>();
    f.controlRequest.mockImplementationOnce(() => pending.promise);
    f.bridge.initialized(undefined);
    await vi.waitFor(() => expect(f.controlRequest).toHaveBeenCalledOnce());
    f.bridge.close();
    pending.resolve({ result: { account: null } });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.scope.gate.phase).toBe("ready");
    expect(f.scope.owner.running).toBe(true);
  });

  it("does not route externally supplied tokens or API keys into managed ChatGPT login", async () => {
    const f = fixture();
    const respond = vi.fn<(result: JsonObject) => Promise<void>>(async () => {});
    for (const type of ["chatgptAuthTokens", "apiKey", "amazonBedrock"]) {
      await expect(f.bridge.request("account/login/start", { type }, respond)).rejects.toThrow();
    }
    expect(f.control.startNativeLogin).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });
});
