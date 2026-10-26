import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developmentHostFingerprint, restartDevelopmentHost } from "./host.mjs";
import { shouldRestartHost } from "./host-restart.mjs";

const directories = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "codexhost-fingerprint-"));
  directories.push(root);
  const data = path.join(root, "data");
  await mkdir(data);
  const put = async (file, contents = "fixture") => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  };
  await put("package-lock.json");
  await put("packages/host-runtime/dist/main.js");
  const artifacts = {
    launcher: "/launcher",
    node: "/node",
    hostRuntime: path.join(root, "packages/host-runtime/dist/main.js"),
  };
  await put(
    "data/shared-host-ready.json",
    JSON.stringify({ pid: process.pid, runtime: artifacts.hostRuntime }),
  );
  const record = path.join(data, "dev-host-fingerprint.json");
  const run = vi.fn(async () => ({ code: 0 }));
  const webRunning = vi.fn(async () => false);
  return {
    root,
    data,
    put,
    record,
    artifacts,
    run,
    webRunning,
    environment: {
      CODEXHOST_DATA_DIR: data,
      CODEXHOST_NPM_PACKAGE_ROOT: "/old",
      HTTPS_PROXY: "http://proxy",
    },
  };
}

describe("development Host restart", () => {
  it("restarts a changed build without Web and records its fingerprint only after success", async () => {
    const f = await fixture();
    f.run.mockImplementationOnce(async (invocation, env) => {
      expect(invocation).toEqual({
        command: "/launcher",
        arguments: [
          "host",
          "restart",
          "--node",
          "/node",
          "--host-runtime",
          f.artifacts.hostRuntime,
          "--data",
          f.data,
        ],
      });
      expect(env).toEqual({ CODEXHOST_DATA_DIR: f.data, HTTPS_PROXY: "http://proxy" });
      await expect(readFile(f.record)).rejects.toThrow();
      return { code: 0 };
    });
    await restartDevelopmentHost(f);
    expect(JSON.parse(await readFile(f.record, "utf8"))).toEqual({
      runtime: f.artifacts.hostRuntime,
      fingerprint: await developmentHostFingerprint(f.root),
    });
    expect(f.environment.CODEXHOST_NPM_PACKAGE_ROOT).toBe("/old");
    f.run.mockClear();
    f.webRunning.mockClear();
    await restartDevelopmentHost(f);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.webRunning).not.toHaveBeenCalled();
  });

  it.each(["", "restart"])(
    "asks when changed with Web open (%s), keeping the old record until restart",
    async (answer) => {
      const f = await fixture();
      const old = JSON.stringify({ runtime: f.artifacts.hostRuntime, fingerprint: "old" });
      await writeFile(f.record, old);
      const ask = vi.fn(async () => answer);
      await restartDevelopmentHost({
        ...f,
        webRunning: async () => true,
        decide: (options) =>
          shouldRestartHost({ ...options, interactive: true, ask, log: vi.fn() }),
      });
      expect(ask).toHaveBeenCalledOnce();
      expect(f.run).toHaveBeenCalledTimes(answer ? 1 : 0);
      if (!answer) expect(await readFile(f.record, "utf8")).toBe(old);
    },
  );

  it("warns and keeps Host non-interactively; explicit modes bypass Web detection and prompts", async () => {
    const f = await fixture();
    const ask = vi.fn();
    const warn = vi.fn();
    const decide = (options) =>
      shouldRestartHost({ ...options, interactive: false, ask, warn, log: vi.fn() });
    await restartDevelopmentHost({ ...f, webRunning: async () => true, decide });
    expect(f.run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("--restart-host"));
    await expect(readFile(f.record)).rejects.toThrow();
    await restartDevelopmentHost({ ...f, mode: "keep", decide });
    expect(f.webRunning).not.toHaveBeenCalled();
    await restartDevelopmentHost({ ...f, mode: "restart", decide });
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.webRunning).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("does not mistake a different running runtime for the recorded build", async () => {
    const f = await fixture();
    await restartDevelopmentHost(f);
    f.run.mockClear();
    await restartDevelopmentHost({ ...f, readHost: async () => ({ runtime: "/other/host.js" }) });
    expect(f.run).toHaveBeenCalledOnce();
  });

  it.each([undefined, "restart", "keep"])(
    "records an absent Host build for ensure and reuses it on the next start (mode=%s)",
    async (mode) => {
      const f = await fixture();
      await rm(f.data, { recursive: true });
      const fingerprint = vi.fn(developmentHostFingerprint);
      const decide = vi.fn();
      await restartDevelopmentHost({ ...f, mode, fingerprint, decide });
      expect(f.run).not.toHaveBeenCalled();
      expect(decide).not.toHaveBeenCalled();
      expect(f.webRunning).not.toHaveBeenCalled();
      expect(fingerprint).toHaveBeenCalledExactlyOnceWith(f.root);
      expect(JSON.parse(await readFile(f.record, "utf8"))).toEqual({
        runtime: f.artifacts.hostRuntime,
        fingerprint: await developmentHostFingerprint(f.root),
      });

      await f.put(
        "data/shared-host-ready.json",
        JSON.stringify({ pid: process.pid, runtime: f.artifacts.hostRuntime }),
      );
      await restartDevelopmentHost(f);
      expect(f.run).not.toHaveBeenCalled();
      expect(f.webRunning).not.toHaveBeenCalled();
    },
  );

  it("stops interface startup on failed restart and does not write a fingerprint", async () => {
    const f = await fixture();
    f.run.mockResolvedValue({ code: 1 });
    await expect(restartDevelopmentHost(f)).rejects.toThrow("Host restart failed");
    await expect(readFile(f.record)).rejects.toThrow();
  });

  it.each([
    "packages/desktop-control/dist/index.js",
    "packages/host-runtime/dist/plugins/claude-code/plugin.mjs",
    "packages/host-runtime/dist/plugins/claude-code/manifest.json",
    "packages/host-runtime/dist/plugins/enabled.json",
  ])(
    "tracks changes to %s but stays stable when identical contents are rewritten",
    async (file) => {
      const f = await fixture();
      await f.put(file, "initial contents");
      const initial = await developmentHostFingerprint(f.root);
      await f.put(file, "initial contents");
      expect(await developmentHostFingerprint(f.root)).toBe(initial);
      await f.put(file, "changed contents");
      expect(await developmentHostFingerprint(f.root)).not.toBe(initial);
    },
  );

  it("hashes JS content, relative paths and lockfile, excluding Web/Renderer dist, node_modules and unrelated files", async () => {
    const f = await fixture();
    const first = await developmentHostFingerprint(f.root);
    for (const file of [
      "packages/web-server/dist/server.js",
      "packages/renderer-extension/dist/production.js",
      "packages/renderer-extension/dist/nested/plugin.js",
      "packages/host-runtime/dist/plugins/claude-code/plugin.mjs.map",
      "packages/x/dist/manifest.json",
      "packages/x/node_modules/a/dist/a.js",
      "packages/host-runtime/dist/main.js.map",
      "packages/x/src/a.js",
    ])
      await f.put(file, "ignored");
    expect(await developmentHostFingerprint(f.root)).toBe(first);
    await f.put("packages/host-runtime/dist/main.js", "changed");
    const second = await developmentHostFingerprint(f.root);
    expect(second).not.toBe(first);
    await f.put("package-lock.json", "changed lock");
    const third = await developmentHostFingerprint(f.root);
    expect(third).not.toBe(second);
    await f.put("packages/adapters/a/dist/nested/plugin.js");
    const fourth = await developmentHostFingerprint(f.root);
    expect(fourth).not.toBe(third);
    await rm(path.join(f.root, "packages/adapters/a/dist/nested/plugin.js"));
    await f.put("packages/adapters/a/dist/nested/renamed.js");
    expect(await developmentHostFingerprint(f.root)).not.toBe(fourth);
  });
});
