import { describe, expect, it, vi } from "vitest";
import {
  isAnyDevelopmentWeb,
  isDesktopRunning,
  isWebRunning,
  macOsDesktopDetectionScript,
  windowsDesktopDetectionScript,
} from "./interface-processes.mjs";
import { runningDesktopCleanupInvocation } from "./run.mjs";

describe("development interface detection", () => {
  it("shares detection identities with cleanup, without executing cleanup commands", async () => {
    for (const [platform, snippet] of [
      ["darwin", macOsDesktopDetectionScript],
      ["win32", windowsDesktopDetectionScript],
    ]) {
      expect(runningDesktopCleanupInvocation(platform).arguments.at(-1)).toContain(snippet);
      for (const running of [true, false]) {
        const run = vi.fn(async () => ({ stdout: `${running}\n` }));
        expect(await isDesktopRunning(platform, run)).toBe(running);
        const script = run.mock.calls[0][1].at(-1);
        expect(script).toContain(snippet);
        expect(script).not.toMatch(/pkill|Stop-Process|kill -/u);
      }
    }
    const run = vi.fn();
    expect(await isDesktopRunning("linux", run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("matches packed Node Web services on any port/worktree, not unrelated command arguments", async () => {
    for (const command of [
      "/different/node /other/tree/app/server.mjs --port 4401",
      '"/node install/node" "/other tree/app/server.mjs" --port 4400',
      "/different/node /other tree/app/server.mjs --port 0",
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\app\\server.mjs" --port 4405',
      "node /packed/app/server.mjs",
    ]) {
      expect(isAnyDevelopmentWeb({ command })).toBe(true);
      expect(await isWebRunning(async () => [{ command }])).toBe(true);
    }
    for (const command of [
      "/node other.js --entry /packed/app/server.mjs --port 4400",
      "/node /packed/app/server.mjs.bak --port 4400",
      "/python /packed/app/server.mjs --port 4400",
      "sh -c node /packed/app/server.mjs --port 4400",
      "/node /packed/app/not-server.mjs --port 4400",
    ])
      expect(isAnyDevelopmentWeb({ command })).toBe(false);
    expect(await isWebRunning(async () => [])).toBe(false);
  });
});
