import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";
import { createHostWebOpener } from "../src/web-opener.js";

const launcher = path.resolve("installation/bin/codexhost");
let root: string;
let runtime: string;

function child(code: number, stderr = "") {
  const process = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
  setImmediate(() => {
    process.stderr.end(stderr);
    process.emit("close", code);
  });
  return process;
}

beforeEach(async () => {
  vi.mocked(spawn).mockReset();
  root = await mkdtemp(path.join(tmpdir(), "codexhost-web-opener-"));
  runtime = path.join(root, "app/host-runtime.mjs");
  await mkdir(path.dirname(runtime));
  await writeFile(
    path.join(root, "app/codexhost-distribution.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: "0.17.3",
      distribution: "installer",
      target: "macos-arm64",
    }),
  );
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("Host Web opener", () => {
  it("delegates startup and browser opening to the installed Launcher with the Host environment", async () => {
    vi.mocked(spawn).mockImplementation(() => child(0) as never);
    const environment = {
      CODEXHOST_LAUNCHER_EXECUTABLE: launcher,
      CODEXHOST_HOST_RUNTIME_PATH: runtime,
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

  it.each(["checkout", "snapshot"])(
    "rejects a development %s without starting the Launcher",
    async (layout) => {
      await rm(path.join(root, "app/codexhost-distribution.json"));
      if (layout === "checkout") {
        runtime = path.join(root, "packages/host-runtime/dist/main.js");
        await writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "codexhost", version: "0.17.3" }),
        );
      }
      const opener = createHostWebOpener({
        CODEXHOST_LAUNCHER_EXECUTABLE: launcher,
        CODEXHOST_HOST_RUNTIME_PATH: runtime,
      });
      expect(opener).toBeDefined();
      await expect(opener?.open()).rejects.toThrow(
        "Background Web is unavailable in a development build; run npm start web",
      );
      expect(spawn).not.toHaveBeenCalled();
    },
  );

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
    vi.mocked(spawn).mockImplementation(
      () => child(1, "Web startup failed: port 4478 is in use\n") as never,
    );
    await expect(
      createHostWebOpener({
        CODEXHOST_LAUNCHER_EXECUTABLE: launcher,
        CODEXHOST_HOST_RUNTIME_PATH: runtime,
      })?.open(),
    ).rejects.toThrow("Web startup failed: port 4478 is in use");
  });
});
