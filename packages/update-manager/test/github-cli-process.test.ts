import { execFile } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { fetchLatestGitHubReleaseWithGitHubCli } from "@codexhost/update-manager";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  execFile: vi.fn(),
}));

describe("GitHub CLI process", () => {
  it("bounds subprocess time/output and silently falls back on failure", async () => {
    const command = vi.mocked(execFile);
    const controller = new AbortController();
    const pending = fetchLatestGitHubReleaseWithGitHubCli({
      executableCandidates: ["/custom/gh"],
      environment: { PATH: "/bin" },
      signal: controller.signal,
    });
    expect(command).toHaveBeenCalledWith(
      "/custom/gh",
      expect.any(Array),
      {
        encoding: "utf8",
        env: { PATH: "/bin" },
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
        windowsHide: true,
        signal: controller.signal,
      },
      expect.any(Function),
    );
    const callback = command.mock.calls[0]?.[3] as unknown as (
      error: Error,
      stdout: string,
      stderr: string,
    ) => void;
    callback(new Error("timed out"), "", "private debug data");
    await expect(pending).resolves.toBeNull();
    expect(command).toHaveBeenCalledOnce();
  });
});
