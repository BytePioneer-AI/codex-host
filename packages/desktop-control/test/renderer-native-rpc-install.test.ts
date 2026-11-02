import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { installNativeRpcRemoteControlDirect } from "../src/renderer-native-rpc-install.js";

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
