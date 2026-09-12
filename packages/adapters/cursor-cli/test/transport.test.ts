import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorTransport, type CursorCallbacks } from "../src/transport.js";

const state = vi.hoisted(() => ({ scenario: "normal" }));
vi.mock("../src/command.js", () => ({
  cursorInvocation: () => ({
    command: process.execPath,
    arguments: [path.resolve("packages/adapters/cursor-cli/test/fixtures/acp.mjs"), state.scenario],
    windowsVerbatimArguments: false,
  }),
}));
const transports: CursorTransport[] = [];
function transport(timeoutMs = 2_000) {
  const result = new CursorTransport({ cwd: process.cwd(), environment: process.env, timeoutMs });
  transports.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  state.scenario = "normal";
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
