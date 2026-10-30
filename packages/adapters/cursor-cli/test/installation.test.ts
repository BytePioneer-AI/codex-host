import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn(), invocation: vi.fn() }));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
}));
vi.mock("../src/command.js", () => ({ cursorInvocation: mocks.invocation }));
import { createCursorInstallation } from "../src/installation.js";

describe("Cursor native version maintenance", () => {
  it("preserves the Windows bundled Node prefix for check, update and readback", async () => {
    const environment = { CODEXHOST_CURSOR_COMMAND: "/chosen/cursor" };
    mocks.invocation.mockImplementation((_env, _command, args) => ({
      command: "/cursor/node.exe",
      arguments: ["/cursor/index.js", ...args],
    }));
    let updated = false;
    mocks.run.mockImplementation(async (_command, args) => {
      if (args[1] === "update") {
        updated = true;
        return "ok";
      }
      return JSON.stringify({
        cliVersion: updated ? "2026.09.24-abc" : "2026.09.23-abc",
        latestVersion: "2026.09.24-abc",
        latestStatus: updated ? "up_to_date" : "update_available",
      });
    });
    const installation = createCursorInstallation(environment);
    await expect(installation("update")).resolves.toMatchObject({ updateAvailable: false });
    expect(mocks.invocation).toHaveBeenCalledWith(environment, undefined, [
      "about",
      "--format",
      "json",
    ]);
    expect(mocks.run).toHaveBeenCalledWith(
      "/cursor/node.exe",
      ["/cursor/index.js", "update"],
      environment,
      300_000,
    );
  });
});
