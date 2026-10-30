import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import type { CodexAccountListResult } from "@codexhost/shared-contracts";
import { OfficialWorkGate } from "../src/codex-runtime/official-work-gate.js";
import { NativeAccountObserver } from "../src/native-account-observer.js";

const observers = new Set<NativeAccountObserver>();
afterEach(() => {
  for (const observer of observers) observer.close();
  observers.clear();
});
function fixture() {
  const gate = new OfficialWorkGate();
  gate.initialized();
  const controlRequest = vi.fn<(method: string, params: JsonObject) => Promise<JsonObject>>(
    async () => ({
      result: { account: { type: "chatgpt", planType: "pro" } },
    }),
  );
  const scope = { gate, closed: false, owner: { generation: 1, running: true, controlRequest } };
  const snapshot: CodexAccountListResult = {
    version: 2,
    currentAccountId: null,
    phase: "ready",
    revision: 0,
    accounts: [],
  };
  const refresh = vi.fn(async () => snapshot);
  const notify = vi.fn<(method: string, params: JsonObject) => Promise<void>>(async () => {});
  const diagnose = vi.fn();
  const observer = new NativeAccountObserver({ scope, control: { refresh }, notify, diagnose });
  observers.add(observer);
  return { observer, scope, refresh, snapshot, controlRequest, notify, diagnose };
}

describe("native Account observation", () => {
  it("publishes the current identity after native initialization without an account probe", async () => {
    const f = fixture();
    const collected = Promise.withResolvers<typeof f.snapshot>();
    f.refresh.mockReturnValueOnce(collected.promise);
    f.observer.initialized(1);
    expect(f.controlRequest).not.toHaveBeenCalled();
    expect(f.scope.gate.phase).toBe("ready");
    expect(f.notify).not.toHaveBeenCalled();
    collected.resolve(f.snapshot);
    await vi.waitFor(() =>
      expect(f.notify).toHaveBeenCalledWith("codexhost/account/changed", f.snapshot),
    );
    expect(f.controlRequest).not.toHaveBeenCalled();
  });

  it("announces only a ready replacement backend, never an intermediate generation", async () => {
    const f = fixture();
    f.observer.initialized(1);
    expect(f.controlRequest).not.toHaveBeenCalled();
    f.scope.gate.unavailable();
    f.scope.owner.generation = 2;
    f.observer.initialized(undefined);
    await Promise.resolve();
    expect(f.notify).not.toHaveBeenCalled();
    f.scope.owner.generation = 3;
    f.scope.gate.initialized();
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
    expect(f.controlRequest).toHaveBeenCalledWith("account/read", { refreshToken: false });
    expect(f.notify).toHaveBeenCalledWith("account/updated", {
      authMode: "chatgpt",
      planType: "pro",
    });
    f.scope.gate.initialized();
    await Promise.resolve();
    expect(f.controlRequest).toHaveBeenCalledOnce();
  });

  it("discards a retired generation without blocking a replacement backend", async () => {
    const f = fixture();
    const old = Promise.withResolvers<JsonObject>();
    f.controlRequest.mockImplementationOnce(() => old.promise);
    f.observer.initialized(undefined);
    await vi.waitFor(() => expect(f.controlRequest).toHaveBeenCalledOnce());
    expect(f.scope.gate.busy).toBe(false);
    f.scope.gate.unavailable();
    f.scope.owner.generation = 2;
    f.scope.gate.initialized();
    old.resolve({ result: { account: null } });
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
    expect(f.controlRequest).toHaveBeenCalledTimes(2);
    expect(f.notify).toHaveBeenCalledWith("account/updated", {
      authMode: "chatgpt",
      planType: "pro",
    });
  });

  it("publishes the official signed-out state after backend initialization", async () => {
    const f = fixture();
    f.controlRequest.mockResolvedValue({ result: { account: null } });
    f.observer.initialized(undefined);
    await vi.waitFor(() =>
      expect(f.notify).toHaveBeenCalledWith("account/updated", { authMode: null, planType: null }),
    );
  });

  it("isolates notification errors without retries or readiness changes", async () => {
    const f = fixture();
    f.controlRequest.mockResolvedValue({
      error: { code: -1, message: "synthetic private diagnostic" },
    });
    f.observer.initialized(undefined);
    await vi.waitFor(() => expect(f.diagnose).toHaveBeenCalledOnce());
    expect(f.controlRequest).toHaveBeenCalledOnce();
    expect(f.diagnose).toHaveBeenCalledWith();
    expect(f.scope.gate.phase).toBe("ready");
    expect(f.notify).not.toHaveBeenCalled();
  });

  it.each(["account/updated", "account/login/completed"])(
    "collects after %s without generating native authentication events",
    async (method) => {
      const f = fixture();
      f.observer.observe({ method, params: { futureField: true } });
      await vi.waitFor(() =>
        expect(f.notify).toHaveBeenCalledWith("codexhost/account/changed", f.snapshot),
      );
      expect(f.refresh).toHaveBeenCalledOnce();
      expect(f.controlRequest).not.toHaveBeenCalled();
      expect(f.notify).toHaveBeenCalledOnce();
    },
  );

  it("refreshes again if another native change arrives during an identity read", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<typeof f.snapshot>();
    f.refresh.mockImplementationOnce(() => pending.promise);
    f.observer.observe({ method: "account/updated" });
    f.observer.observe({ method: "account/updated" });
    pending.resolve(f.snapshot);
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(2));
  });

  it("does not close admission when an identity read fails; a later observation can retry", async () => {
    const f = fixture();
    f.refresh.mockRejectedValueOnce(new Error("synthetic private identity read failure"));
    f.observer.observe({ method: "account/updated" });
    await vi.waitFor(() => expect(f.diagnose).toHaveBeenCalledOnce());
    expect(f.diagnose).toHaveBeenCalledWith();
    expect(f.scope.gate.phase).toBe("ready");
    expect(f.notify).not.toHaveBeenCalled();
    f.observer.observe({ method: "account/updated" });
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
  });

  it("never publishes late native or identity results after closing", async () => {
    const f = fixture();
    const native = Promise.withResolvers<JsonObject>();
    const backup = Promise.withResolvers<typeof f.snapshot>();
    f.controlRequest.mockImplementationOnce(() => native.promise);
    f.refresh.mockImplementationOnce(() => backup.promise);
    f.observer.initialized(undefined);
    f.observer.observe({ method: "account/updated" });
    f.observer.close();
    native.resolve({ result: { account: null } });
    backup.resolve(f.snapshot);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.scope.gate.phase).toBe("ready");
  });
});
