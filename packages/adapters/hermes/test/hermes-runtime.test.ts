import { spawnSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hermesPythonCommand, nativeHermesPythonCommand } from "../src/hermes-runtime.js";

const nativeCommand = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcess>();
  const { promisify } = await import("node:util");
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: nativeCommand }) };
});
beforeEach(() => {
  nativeCommand.mockReset();
});

const runtime = { python: "/managed/python", launcher: "/selected/hermes" };
describe("Hermes native runtime commands", () => {
  it("preserves the native bootstrap command for every script", async () => {
    nativeCommand.mockResolvedValue({
      stdout: JSON.stringify([runtime.python, "-I", "-c", "native bootstrap", "timeit"]),
    });
    const command = await hermesPythonCommand(runtime, "print('safe')", {
      HERMES_HOME: "/selected/home",
    });
    expect(command).toEqual({
      command: runtime.python,
      arguments: ["-I", "-c", "native bootstrap", "timeit"],
    });
    expect(nativeCommand.mock.calls[0]?.[1][9]).toContain("sys.stdout = io.StringIO()");
    expect(nativeCommand.mock.calls[0]?.[2].env.HERMES_HOME).toBe("/selected/home");
  });
  it("permits legacy discovery only when the launch interface is unsupported", async () => {
    nativeCommand.mockRejectedValue(new Error("unrecognized arguments: --print-runtime-command"));
    await expect(nativeHermesPythonCommand(runtime.launcher, "pass", {})).resolves.toBeNull();
    await expect(hermesPythonCommand(runtime, "pass", {})).rejects.toThrow("no longer supports");
  });
  it.each([new Error("runtime timeout"), new Error("permission denied")])(
    "does not downgrade on native command errors",
    async (error) => {
      nativeCommand.mockRejectedValue(error);
      await expect(nativeHermesPythonCommand(runtime.launcher, "pass", {})).rejects.toThrow(
        error.message,
      );
    },
  );
  it.each(["not json", "[]", '["", "-c"]', "[123]"])(
    "rejects malformed native commands: %s",
    async (stdout) => {
      nativeCommand.mockResolvedValue({ stdout });
      await expect(nativeHermesPythonCommand(runtime.launcher, "pass", {})).rejects.toThrow();
    },
  );
  it("keeps legacy Python supported and activates bootstrap before imports", async () => {
    const command = await hermesPythonCommand(
      "/legacy/python",
      "from tui_gateway import server",
      {},
    );
    expect(command.command).toBe("/legacy/python");
    expect(command.arguments.slice(0, 3)).toEqual(["-I", "-u", "-c"]);
    expect(command.arguments[3]).toContain("import hermes_bootstrap\nfrom tui_gateway");
    expect(nativeCommand).not.toHaveBeenCalled();
  });
  const python = process.platform === "win32" ? "python" : "python3";
  it.skipIf(spawnSync(python, ["--version"]).status !== 0)(
    "never adds timing output to RPC or history stdout",
    async () => {
      // Run the actual stdlib module boundary used by the native launcher.
      let setup = "";
      nativeCommand.mockImplementation(async (_launcher, args) => {
        setup = args[9];
        return { stdout: JSON.stringify([python, "-m", "timeit", ...args.slice(4)]) };
      });
      const command = await hermesPythonCommand(runtime, 'print("{\\\"result\\\":true}")', {});
      const output = spawnSync(command.command, command.arguments, { encoding: "utf8" });
      expect(setup).toContain("sys.stdout = io.StringIO()");
      expect(output.status).toBe(0);
      // Python writes CRLF line endings on Windows; every reader trims or splits lines.
      expect(output.stdout.replaceAll("\r\n", "\n")).toBe('{"result":true}\n');
    },
  );
});
