import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  consoleEntrypoint,
  createHostConsoleOpener,
  parseConsoleAddress,
} from "../src/console-opener.js";

function fakeChild(stdout: string, stderr: string, code: number) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  setImmediate(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    setImmediate(() => child.emit("exit", code));
  });
  return child;
}

describe("Host console opener", () => {
  it("finds the console beside a release Host Runtime or in a source checkout", () => {
    expect(consoleEntrypoint("/opt/codexhost/app/host-runtime.mjs", () => true)).toBe(
      path.join("/opt/codexhost/app", "console-server.mjs"),
    );
    expect(consoleEntrypoint("/repo/packages/host-runtime/dist/main.js", () => true)).toBe(
      path.resolve("/repo/packages/console-server/dist/main.js"),
    );
    expect(consoleEntrypoint("/opt/codexhost/app/host-runtime.mjs", () => false)).toBeNull();
  });

  it("reports the console root address", () => {
    expect(
      parseConsoleAddress("codexhost console: http://127.0.0.1:4399/?view=diagnostics\n"),
    ).toBe("http://127.0.0.1:4399/");
    expect(parseConsoleAddress("codexhost console: https://evil.example/\n")).toBeNull();
    expect(parseConsoleAddress("nothing\n")).toBeNull();
  });

  it("runs console-server open with the Host environment", async () => {
    const spawnProcess = vi.fn(() =>
      fakeChild("codexhost console: http://127.0.0.1:4399/\n", "", 0),
    );
    const opener = createHostConsoleOpener({
      entrypoint: "/opt/codexhost/app/console-server.mjs",
      environment: { CODEXHOST_LAUNCHER_EXECUTABLE: "/opt/codexhost/bin/codexhost" },
      nodePath: "/opt/codexhost/runtime/node",
      spawnProcess: spawnProcess as never,
    });
    await expect(opener.open()).resolves.toEqual({ url: "http://127.0.0.1:4399/" });
    expect(spawnProcess).toHaveBeenCalledWith(
      "/opt/codexhost/runtime/node",
      ["/opt/codexhost/app/console-server.mjs", "open"],
      expect.objectContaining({
        env: { CODEXHOST_LAUNCHER_EXECUTABLE: "/opt/codexhost/bin/codexhost" },
      }),
    );
  });

  it("surfaces the console's error", async () => {
    const opener = createHostConsoleOpener({
      entrypoint: "/console.mjs",
      environment: {},
      spawnProcess: (() =>
        fakeChild("", "codexhost console: port 4399 is used by another program\n", 1)) as never,
    });
    await expect(opener.open()).rejects.toThrow("port 4399 is used by another program");
  });
});
