import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";
import { createHostWebOpener } from "../src/web-opener.js";

const launcher = path.resolve("installation/bin/codexhost");

function child(code: number, stderr = "") {
  const process = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
  setImmediate(() => {
    process.stderr.end(stderr);
    process.emit("close", code);
  });
  return process;
}

beforeEach(() => vi.mocked(spawn).mockReset());

describe("Host Web opener", () => {
  it("delegates startup and browser opening to the installed Launcher with the Host environment", async () => {
    vi.mocked(spawn).mockReturnValue(child(0) as never);
    const environment = {
      CODEXHOST_LAUNCHER_EXECUTABLE: launcher,
      CODEXHOST_DATA_DIR: path.resolve("data"),
      CODEXHOST_NPM_NODE_PATH: path.resolve("runtime/node"),
      HOME: path.resolve("home"),
    };
    await expect(createHostWebOpener(environment)?.open()).resolves.toEqual({});
    expect(spawn).toHaveBeenCalledExactlyOnceWith(launcher, ["web", "--connect-devices"], {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
  });

  it("does not use PATH or open a browser on a remote Host", () => {
    expect(createHostWebOpener({})).toBeUndefined();
    expect(createHostWebOpener({ CODEXHOST_LAUNCHER_EXECUTABLE: "codexhost" })).toBeUndefined();
    expect(
      createHostWebOpener({
        CODEXHOST_LAUNCHER_EXECUTABLE: launcher,
        CODEXHOST_REMOTE_SSH_MANAGED: "1",
      }),
    ).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports Launcher startup failure", async () => {
    vi.mocked(spawn).mockReturnValue(
      child(1, "Web startup failed: port 4478 is in use\n") as never,
    );
    await expect(
      createHostWebOpener({ CODEXHOST_LAUNCHER_EXECUTABLE: launcher })?.open(),
    ).rejects.toThrow("Web startup failed: port 4478 is in use");
  });
});
