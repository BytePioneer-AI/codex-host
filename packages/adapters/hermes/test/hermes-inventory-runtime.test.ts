import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as childProcess from "node:child_process";
import { readHermesModelInventory } from "../src/hermes-inventory.js";

const nativeCommand = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  const { promisify } = await import("node:util");
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: nativeCommand }) };
});
beforeEach(() => vi.resetAllMocks());

function runtime(stdout: string, exitCode = 0) {
  nativeCommand.mockResolvedValue({
    stdout: JSON.stringify([
      process.execPath,
      "-e",
      `process.stdout.write(${JSON.stringify(stdout)});process.exitCode=${exitCode}`,
    ]),
  });
}

describe("Hermes installation-bound inventory runtime", () => {
  it("uses the native runtime command, retaining bootstrap and reading configuration evidence", async () => {
    runtime(
      'codexhost_inventory={"models":[],"currentModelId":null,"configured":false}\n1 loop, best of 1: 1 usec per loop\n',
    );
    expect(
      await readHermesModelInventory("/selected/hermes", 1000, {
        environment: { HERMES_HOME: "/selected/home" },
      }),
    ).toEqual({ models: [], currentModelId: null, configured: false });
    const call = nativeCommand.mock.calls[0];
    if (!call) throw new Error("Expected native runtime resolution");
    const [executable, args, options] = call;
    expect(executable).toBe("/selected/hermes");
    expect(args.slice(0, 10)).toEqual([
      "--print-runtime-command",
      "--module",
      "timeit",
      "--",
      "-n",
      "1",
      "-r",
      "1",
      "-s",
      expect.stringContaining("_has_any_provider_configured"),
    ]);
    expect(options.env.HERMES_HOME).toBe("/selected/home");
    expect(options.timeout).toBe(1000);
  });

  it("does not silently fall back when an advertised runtime fails", async () => {
    runtime("", 1);
    await expect(readHermesModelInventory("/selected/hermes")).rejects.toThrow(
      "probe exited with 1",
    );
  });

  it("rejects malformed inventory rather than guessing configuration from missing models", async () => {
    runtime("codexhost_inventory=invalid\n");
    await expect(readHermesModelInventory("/selected/hermes")).rejects.toThrow("malformed output");
  });

  it("falls back to legacy discovery when the native runtime interface is unsupported", async () => {
    nativeCommand.mockRejectedValue(new Error("unknown option"));
    await expect(
      readHermesModelInventory("/nonexistent-codexhost-hermes/bin/hermes"),
    ).rejects.toThrow("inventory interpreter not found");
  });
});
