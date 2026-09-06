import { EventEmitter } from "node:events";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createLauncherUrlOpener } from "../src/launcher-url-opener.js";

type SpawnLauncher = NonNullable<Parameters<typeof createLauncherUrlOpener>[1]>;

function childThatExits(code?: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdin: new PassThrough(), kill: vi.fn(() => true) });
  if (code !== undefined) queueMicrotask(() => child.emit("exit", code, null));
  return child;
}

describe("Launcher URL opener", () => {
  it("hands one validated loopback URL to the native Launcher without a shell", async () => {
    const launcher = path.resolve("fixture-codexhost");
    const child = childThatExits(0);
    let input = "";
    child.stdin?.on("data", (chunk) => (input += chunk.toString()));
    const spawnLauncher = vi.fn<SpawnLauncher>(() => child);
    const open = createLauncherUrlOpener(
      {
        CODEXHOST_LAUNCHER_EXECUTABLE: launcher,
        codexhost_control_nonce: "secret",
        CODEX_CLI_PATH: "secret",
        SystemRoot: String.raw`C:\Windows`,
      },
      spawnLauncher,
    );
    const url = new URL(`http://127.0.0.1:4567/?token=${"A".repeat(43)}`);

    await expect(open?.(url)).resolves.toBeUndefined();
    expect(spawnLauncher).toHaveBeenCalledWith(launcher, ["open-loopback-url"], {
      env: { SystemRoot: String.raw`C:\Windows` },
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    expect(input).toBe(url.href);
    expect(spawnLauncher.mock.calls[0]?.[2]).not.toHaveProperty("shell");
  });

  it("rejects non-loopback and failed handoffs without returning the URL", async () => {
    const launcher = path.resolve("fixture-codexhost");
    const spawnLauncher = vi.fn<SpawnLauncher>(() => childThatExits(1));
    const open = createLauncherUrlOpener(
      { CODEXHOST_LAUNCHER_EXECUTABLE: launcher },
      spawnLauncher,
    );
    const token = "SECRET_CANARY";

    await expect(open?.(new URL(`https://example.com/?token=${token}`))).rejects.toThrow(
      "loopback root URL",
    );
    await expect(open?.(new URL(`http://127.0.0.1:4567/?token=${token}`))).rejects.not.toThrow(
      token,
    );
    expect(spawnLauncher).toHaveBeenCalledOnce();
    expect(createLauncherUrlOpener({ CODEXHOST_LAUNCHER_EXECUTABLE: "relative" })).toBeUndefined();
  });

  it("bounds a native opener that never exits", async () => {
    vi.useFakeTimers();
    try {
      const child = childThatExits();
      const open = createLauncherUrlOpener(
        { CODEXHOST_LAUNCHER_EXECUTABLE: path.resolve("fixture-codexhost") },
        vi.fn(() => child),
      );
      const rejection = expect(
        open?.(new URL(`http://127.0.0.1:4567/?token=${"A".repeat(43)}`)),
      ).rejects.toThrow("timed out");

      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("absorbs a stdin error that arrives after the child exits", async () => {
    const child = childThatExits(0);
    const open = createLauncherUrlOpener(
      { CODEXHOST_LAUNCHER_EXECUTABLE: path.resolve("fixture-codexhost") },
      vi.fn(() => child),
    );

    await expect(open?.(new URL("http://127.0.0.1:4567/"))).resolves.toBeUndefined();
    expect(() => child.stdin?.emit("error", new Error("late EPIPE"))).not.toThrow();
  });
});
