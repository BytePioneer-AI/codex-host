import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { installNativeRpcRemoteControlDirect } from "../src/renderer-native-rpc-install.js";
import { withNativeRpcComponents } from "../src/renderer-native-rpc-discovery.js";

vi.mock("../src/renderer-native-rpc-discovery.js", () => ({ withNativeRpcComponents: vi.fn() }));

function retryFixture() {
  let now = 0;
  let manager = { kind: "main-process-rpc" };
  const target: Record<string, unknown> = {
    __codexhostHostRoutingV1: { forHost: () => ({ manager }) },
    __codexhostLoadedModulesV1: {
      complete: true,
      owner: "controller-1",
      urls: ["app-shared-a.js", "renderer-app-server-managers-b.js"],
    },
  };
  const renderer = {
    command: vi.fn(async () => ({})),
    async evaluate<T>(expression: string): Promise<T> {
      return runInNewContext(expression, { window: target, Date: { now: () => now } }) as T;
    },
  };
  const discovery = vi.mocked(withNativeRpcComponents).mockReset().mockResolvedValue(false);
  return {
    target,
    renderer,
    discovery,
    advance: (ms: number) => {
      now += ms;
    },
    replaceOwner: () => {
      manager = { kind: "main-process-rpc" };
    },
  };
}

it("retries unavailable discovery after cooldown and deduplicates ready discovery", async () => {
  const f = retryFixture();
  f.discovery.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect(await installNativeRpcRemoteControlDirect(f.renderer)).toBe(false);
  expect(await installNativeRpcRemoteControlDirect(f.renderer)).toBe(false);
  expect(f.discovery).toHaveBeenCalledOnce();
  f.advance(5000);
  expect(await installNativeRpcRemoteControlDirect(f.renderer)).toBe(true);
  expect(f.discovery).toHaveBeenCalledTimes(2);
  f.advance(60000);
  expect(await installNativeRpcRemoteControlDirect(f.renderer)).toBe(false);
  expect(f.discovery).toHaveBeenCalledTimes(2);
});

it("bounds negative discovery per owner/catalog and reopens the budget after owner replacement", async () => {
  const f = retryFixture();
  for (let i = 0; i < 10; i++) {
    await installNativeRpcRemoteControlDirect(f.renderer);
    f.advance(60000);
  }
  expect(f.discovery).toHaveBeenCalledTimes(3);
  f.replaceOwner();
  await installNativeRpcRemoteControlDirect(f.renderer);
  expect(f.discovery).toHaveBeenCalledTimes(4);
  f.target.__codexhostLoadedModulesV1 = {
    complete: true,
    owner: "controller-2",
    urls: ["app-shared-a.js", "renderer-app-server-managers-b.js"],
  };
  await installNativeRpcRemoteControlDirect(f.renderer);
  expect(f.discovery).toHaveBeenCalledTimes(5);
});

it("deduplicates an in-flight probe and ignores its late result after owner replacement", async () => {
  const f = retryFixture();
  let resolve: (value: boolean) => void = () => {};
  let started: () => void = () => {};
  const began = new Promise<void>((done) => {
    started = done;
  });
  f.discovery
    .mockImplementationOnce(() => {
      started();
      return new Promise((done) => {
        resolve = done;
      });
    })
    .mockResolvedValueOnce(true);
  const old = installNativeRpcRemoteControlDirect(f.renderer);
  await began;
  expect(await installNativeRpcRemoteControlDirect(f.renderer)).toBe(false);
  expect(f.discovery).toHaveBeenCalledOnce();
  f.replaceOwner();
  expect(await installNativeRpcRemoteControlDirect(f.renderer)).toBe(true);
  resolve(false);
  await old;
  expect(f.target.__codexhostNativeRpcDiscoveryV1).toMatchObject({ state: "ready" });
  expect(f.discovery).toHaveBeenCalledTimes(2);
});

it("keeps the existing routing intact when the optional probe's Host discovery throws", async () => {
  const routing = {
    forHost: vi.fn(() => {
      throw new Error("Native manager discovery failed");
    }),
  };
  const target = { __codexhostHostRoutingV1: routing };
  const command = vi.fn(async () => ({}));
  const evaluate = vi.fn((expression: string) => runInNewContext(expression, { window: target }));
  const renderer = {
    command,
    async evaluate<T>(expression: string): Promise<T> {
      return evaluate(expression) as T;
    },
  };
  await expect(installNativeRpcRemoteControlDirect(renderer)).resolves.toBe(false);
  expect(target.__codexhostHostRoutingV1).toBe(routing);
  expect(target).not.toHaveProperty("__codexhostNativeRpcDiscoveryV1");
  expect(evaluate).toHaveBeenCalledOnce();
  expect(command).not.toHaveBeenCalled();
});

it("does not propagate an initial CDP evaluation failure or prevent a later probe", async () => {
  const command = vi.fn(async () => ({}));
  const evaluate = vi
    .fn<() => Promise<unknown>>()
    .mockRejectedValueOnce(new Error("Execution context was destroyed"))
    .mockResolvedValueOnce(null);
  const renderer = {
    command,
    async evaluate<T>(): Promise<T> {
      return (await evaluate()) as T;
    },
  };
  await expect(installNativeRpcRemoteControlDirect(renderer)).resolves.toBe(false);
  await expect(installNativeRpcRemoteControlDirect(renderer)).resolves.toBe(false);
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(command).not.toHaveBeenCalled();
});
