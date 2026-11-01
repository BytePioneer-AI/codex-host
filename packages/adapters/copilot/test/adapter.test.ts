import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotClient } from "@github/copilot-sdk";
import { CopilotAdapter } from "../src/adapter.js";
import { createCopilotClient } from "../src/client.js";
vi.mock("../src/client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCopilotClient: vi.fn(),
}));
function client() {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => []),
    forceStop: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ version: "1.0.102", protocolVersion: 3 })),
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: true, authType: "gh-cli" })),
    rpc: { models: { list: vi.fn(async () => ({ models: [] })) } },
    createSession: vi.fn(),
  };
}
beforeEach(() => vi.mocked(createCopilotClient).mockReset());
describe("Copilot inspection", () => {
  it("reuses successful results across elapsed time until an explicit refresh", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const native = client();
    vi.mocked(createCopilotClient).mockReturnValue(native as unknown as CopilotClient);
    const adapter = new CopilotAdapter({});
    try {
      await adapter.inspect({ cwd: "/first" });
      now += 29_999;
      await adapter.inspect({ cwd: "/first" });
      expect(native.start).toHaveBeenCalledTimes(1);
      now += 2;
      await adapter.inspect({ cwd: "/first" });
      now += 24 * 60 * 60 * 1_000;
      await adapter.inspect({ cwd: "/first" });
      expect(native.start).toHaveBeenCalledTimes(1);
      expect(native.rpc.models.list).toHaveBeenCalledTimes(1);
      await adapter.inspect({ cwd: "/first", refresh: true });
      expect(native.start).toHaveBeenCalledTimes(2);
      expect(native.rpc.models.list).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
      clock.mockRestore();
    }
  });

  it("does not cache cleanup failure and retries releasing the retained Client on close", async () => {
    const native = client();
    native.stop.mockRejectedValueOnce(new Error("stop failed"));
    native.forceStop.mockRejectedValueOnce(new Error("force stop failed"));
    vi.mocked(createCopilotClient).mockReturnValue(native as unknown as CopilotClient);
    const adapter = new CopilotAdapter({});
    expect(await adapter.inspect({ cwd: "/first" })).toMatchObject({
      status: "unavailable",
      error: { stage: "inspect.close" },
    });
    await adapter.close();
    expect(native.forceStop).toHaveBeenCalledTimes(2);
  });
  it("coalesces cold, availability, and refresh requests in the same normalized cwd", async () => {
    const native = client();
    const started = Promise.withResolvers<undefined>();
    native.start.mockReturnValue(started.promise);
    vi.mocked(createCopilotClient).mockReturnValue(native as unknown as CopilotClient);
    const adapter = new CopilotAdapter({});
    const first = adapter.inspect({ cwd: "/first", purpose: "availability" });
    const second = adapter.inspect({ cwd: "/first/.", refresh: true });
    const third = adapter.inspect({ cwd: "/first" });
    expect(native.start).toHaveBeenCalledTimes(1);
    started.resolve(undefined);
    const values = await Promise.all([first, second, third]);
    expect(values.every((value) => value.status === "ready")).toBe(true);
    expect(values[0]).toEqual(values[1]);
    expect(native.stop).toHaveBeenCalledTimes(1);
    await adapter.close();
  });

  it("keeps different cwd checks independent", async () => {
    const first = client(),
      second = client();
    const gate = Promise.withResolvers<undefined>();
    first.start.mockReturnValue(gate.promise);
    vi.mocked(createCopilotClient)
      .mockReturnValueOnce(first as unknown as CopilotClient)
      .mockReturnValueOnce(second as unknown as CopilotClient);
    const adapter = new CopilotAdapter({});
    const pending = adapter.inspect({ cwd: "/first" });
    expect((await adapter.inspect({ cwd: "/second" })).status).toBe("ready");
    expect(first.start).toHaveBeenCalledTimes(1);
    expect(second.start).toHaveBeenCalledTimes(1);
    gate.resolve(undefined);
    await pending;
    await adapter.close();
  });

  it("joins a refresh rather than serving stale cache and retries after a failed refresh", async () => {
    const native = client();
    vi.mocked(createCopilotClient).mockReturnValue(native as unknown as CopilotClient);
    const adapter = new CopilotAdapter({});
    await adapter.inspect({ cwd: "/first" });
    const gate = Promise.withResolvers<undefined>();
    native.start.mockReturnValueOnce(gate.promise);
    const refreshed = adapter.inspect({ cwd: "/first", refresh: true });
    const concurrent = adapter.inspect({ cwd: "/first" });
    gate.reject(new Error("native check timed out"));
    expect((await refreshed).status).toBe("unavailable");
    expect((await concurrent).status).toBe("unavailable");
    expect(native.start).toHaveBeenCalledTimes(2);
    expect((await adapter.inspect({ cwd: "/first" })).status).toBe("ready");
    expect(native.start).toHaveBeenCalledTimes(3);
    await adapter.close();
  });

  it("stops and drains an in-flight inspection on close without caching it", async () => {
    const native = client();
    const gate = Promise.withResolvers<undefined>();
    native.start.mockReturnValue(gate.promise);
    native.forceStop.mockImplementation(async () => {
      gate.reject(new Error("connection closed"));
    });
    vi.mocked(createCopilotClient).mockReturnValue(native as unknown as CopilotClient);
    const adapter = new CopilotAdapter({});
    const pending = adapter.inspect({ cwd: "/first" });
    await adapter.close();
    expect(await pending).toMatchObject({ status: "unavailable", error: { code: "invalidState" } });
    expect(native.forceStop).toHaveBeenCalled();
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(native.getStatus).not.toHaveBeenCalled();
    expect((await adapter.inspect({ cwd: "/first", refresh: true })).status).toBe("unavailable");
    expect(createCopilotClient).toHaveBeenCalledTimes(1);
  });
  it("has no native Session side effects and scopes caching to cwd/refresh", async () => {
    const native = client();
    vi.mocked(createCopilotClient).mockReturnValue(native as unknown as CopilotClient);
    const a = new CopilotAdapter({});
    expect((await a.inspect({ cwd: "/first" })).status).toBe("ready");
    await a.inspect({ cwd: "/first" });
    expect(native.start).toHaveBeenCalledTimes(1);
    await a.inspect({ cwd: "/second" });
    await a.inspect({ cwd: "/first", refresh: true });
    expect(native.start).toHaveBeenCalledTimes(3);
    expect(native.stop).toHaveBeenCalledTimes(3);
    expect(native.createSession).not.toHaveBeenCalled();
    await a.close();
    expect((await a.inspect()).status).toBe("unavailable");
  });
  it("separates authentication absence from protocol incompatibility and releases clients", async () => {
    const native = client();
    vi.mocked(createCopilotClient).mockReturnValue(native as unknown as CopilotClient);
    native.getAuthStatus.mockResolvedValue({ isAuthenticated: false, authType: "gh-cli" });
    const a = new CopilotAdapter({});
    expect(await a.inspect({ cwd: "/first" })).toMatchObject({
      status: "unavailable",
      error: { code: "authenticationRequired" },
    });
    native.start.mockRejectedValue(new Error("SDK protocol version mismatch"));
    expect(await a.inspect({ cwd: "/first", refresh: true })).toMatchObject({
      status: "unavailable",
      error: { code: "protocolError" },
    });
    expect(native.stop).toHaveBeenCalledTimes(2);
    await a.close();
  });
});
