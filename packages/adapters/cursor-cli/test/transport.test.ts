import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorTransport, type CursorCallbacks } from "../src/transport.js";

const state = vi.hoisted(() => ({ scenario: "normal", arguments: [] as string[][] }));
vi.mock("../src/command.js", () => ({
  cursorInvocation: (_environment: unknown, _command: unknown, args: string[]) => {
    state.arguments.push(args);
    return {
      command: process.execPath,
      arguments: [
        path.resolve("packages/adapters/cursor-cli/test/fixtures/acp.mjs"),
        state.scenario,
      ],
      windowsVerbatimArguments: false,
    };
  },
}));
const transports: CursorTransport[] = [];
function transport(
  timeoutMs = 2_000,
  loadModelCatalog = true,
  executionPolicy?: "unattended-full-access",
) {
  const result = new CursorTransport({
    cwd: process.cwd(),
    environment: process.env,
    timeoutMs,
    loadModelCatalog,
    ...(executionPolicy ? { executionPolicy } : {}),
  });
  transports.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  state.scenario = "normal";
  state.arguments = [];
});
const callbacks: CursorCallbacks = {
  update: () => {},
  permission: async () => ({ outcome: { outcome: "selected", optionId: "deny" } }),
  extension: async () => ({ outcome: { outcome: "cancelled" } }),
};
describe("Cursor ACP process boundary", () => {
  it("uses real stdio framing for handshake, native permission and terminal response", async () => {
    const native = transport();
    await native.open();
    const permission = vi.fn(callbacks.permission);
    expect(await native.prompt("synthetic", { ...callbacks, permission })).toEqual({
      stopReason: "end_turn",
    });
    expect(permission).toHaveBeenCalledTimes(1);
    await native.close();
    await native.close();
    await expect(native.prompt("closed", callbacks)).rejects.toThrow();
  });
  it("settles prompt when the owned process exits", async () => {
    state.scenario = "exit";
    const native = transport();
    await native.open();
    await expect(native.prompt("synthetic", callbacks)).rejects.toThrow();
  });
  it("bounds and closes a CLI that never initializes", async () => {
    state.scenario = "hang-startup";
    const native = transport(200);
    await expect(native.open()).rejects.toThrow(/timed out|closed/u);
    await expect(native.open()).rejects.toThrow("reopened");
  });
  it("poisons a timed-out configuration so a late response cannot affect another turn", async () => {
    state.scenario = "hang-config";
    const native = transport(1_000);
    await native.open();
    await expect(native.configure("mode", "plan")).rejects.toThrow(/timed out|closed/u);
    await expect(native.prompt("must not run", callbacks)).rejects.toThrow();
  });
});

it("reads history without waiting for a model catalog that never responds", async () => {
  state.scenario = "hang-models";
  const replay = transport(500, false);
  expect(await replay.open("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toMatchObject({
    configOptions: [],
  });
});

it("authenticates ahead of session adoption without creating or loading a session", async () => {
  state.scenario = "prepare-once";
  const native = transport();
  await Promise.all([native.prepare(), native.prepare()]);
  expect(native.sessionId).toBe("");
  expect(await native.open()).toMatchObject({ sessionId: expect.any(String) });
  await expect(native.open()).rejects.toThrow("reopened");
});

it("reuses a matching model catalog while keeping freshly loaded configuration", async () => {
  state.scenario = "cached-models";
  const cached = [{ value: "model", name: "Model", configOptions: [] }];
  const native = new CursorTransport(
    { cwd: process.cwd(), environment: process.env, timeoutMs: 500 },
    cached,
  );
  transports.push(native);
  const info = await native.open();
  expect(info.nativeModels).toEqual(cached);
  expect(info.nativeModels).not.toBe(cached);
  expect(info.configOptions).toMatchObject([{ id: "model", currentValue: "model" }]);
});

it("refreshes a cached catalog when the native session advertises different models", async () => {
  state.scenario = "changed-models";
  const native = new CursorTransport({ cwd: process.cwd(), environment: process.env }, [
    { value: "removed", name: "Removed", configOptions: [] },
  ]);
  transports.push(native);
  expect((await native.open()).nativeModels).toBeUndefined();
});

it("closes a process while authentication is pending without leaving a reusable transport", async () => {
  state.scenario = "hang-auth";
  const native = transport();
  const preparing = native.prepare();
  const failed = expect(preparing).rejects.toThrow(/closed|exited/u);
  await native.close();
  await failed;
  await expect(native.open()).rejects.toThrow("reopened");
});

it("requests native Run Everything only for unattended full access", async () => {
  const unattended = transport(2_000, true, "unattended-full-access");
  await unattended.open();
  expect(state.arguments).toEqual([["--force", "acp"]]);
  const ordinary = transport();
  await ordinary.open();
  expect(state.arguments).toEqual([["--force", "acp"], ["acp"]]);
});
