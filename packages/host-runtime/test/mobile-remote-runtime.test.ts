import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareMobileRemoteRuntime } from "../src/mobile-remote-runtime.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture(version = "0.160.0") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ch-mobile-plan-test-"));
  directories.push(directory);
  const root = path.join(directory, "mobile-codex");
  await mkdir(root);
  const stock = path.join(directory, "stock");
  await writeFile(stock, `#!/bin/sh\necho 'codex-cli ${version}'\n`);
  await chmod(stock, 0o700);
  const binary = Buffer.from("synthetic binary - never executed");
  const files: Record<string, string> = {};
  for (const name of [
    "bin/codex",
    "bin/codex-code-mode-host",
    "codex-path/rg",
    "codex-resources/zsh/bin/zsh",
    "codex-package.json",
  ]) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), binary, { mode: 0o700 });
    files[name] = createHash("sha256").update(binary).digest("hex");
  }
  await writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify({
      version: "0.160.0",
      platform: "darwin",
      architecture: "arm64",
      files,
    }),
  );
  return {
    root,
    stockCodexPath: stock,
    environment: {},
    hostRuntimeUrl: pathToFileURL(path.join(directory, "host-runtime.mjs")).href,
    diagnose: vi.fn(),
    platform: "darwin" as const,
    architecture: "arm64",
  };
}
describe.skipIf(process.platform === "win32")("packaged mobile runtime", () => {
  it("selects a matching verified executable and owns a private short-lived socket directory", async () => {
    const input = await fixture();
    const runtime = await prepareMobileRemoteRuntime(input);
    expect(runtime?.executable).toBe(path.join(input.root, "bin/codex"));
    if (!runtime) throw new Error("Missing runtime");
    expect(path.isAbsolute(runtime.socketPath)).toBe(true);
    await runtime.close();
    await expect(readFile(runtime.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps stock Codex on version mismatch without starting the bridge", async () => {
    const input = await fixture("0.161.0");
    expect(await prepareMobileRemoteRuntime(input)).toBeUndefined();
    expect(input.diagnose).toHaveBeenCalledOnce();
  });
  it("rejects modified packaged executable", async () => {
    const input = await fixture();
    await writeFile(path.join(input.root, "bin/codex"), "tampered");
    expect(await prepareMobileRemoteRuntime(input)).toBeUndefined();
    expect(input.diagnose).toHaveBeenCalledOnce();
  });
  for (const failure of ["missing", "tampered", "not-executable"] as const) {
    it(`keeps the official runtime when the code-mode host is ${failure}`, async () => {
      const input = await fixture();
      const helper = path.join(input.root, "bin/codex-code-mode-host");
      if (failure === "missing") await rm(helper);
      if (failure === "tampered") await writeFile(helper, "tampered");
      if (failure === "not-executable") await chmod(helper, 0o600);
      expect(await prepareMobileRemoteRuntime(input)).toBeUndefined();
      expect(input.diagnose).toHaveBeenCalledOnce();
    });
  }
  for (const name of ["codex-path/rg", "codex-resources/zsh/bin/zsh", "codex-package.json"]) {
    it(`keeps the official runtime when required package resource ${name} is missing`, async () => {
      const input = await fixture();
      await rm(path.join(input.root, name));
      expect(await prepareMobileRemoteRuntime(input)).toBeUndefined();
      expect(input.diagnose).toHaveBeenCalledOnce();
    });
  }
  it("keeps the official runtime for the legacy incomplete distribution manifest", async () => {
    const input = await fixture();
    await writeFile(
      path.join(input.root, "manifest.json"),
      JSON.stringify({
        version: "0.160.0",
        platform: "darwin",
        architecture: "arm64",
        sha256: "a".repeat(64),
      }),
    );
    expect(await prepareMobileRemoteRuntime(input)).toBeUndefined();
    expect(input.diagnose).toHaveBeenCalledOnce();
  });
  it("does not inspect or execute a bridge on unsupported platforms or explicit opt-out", async () => {
    const input = { stockCodexPath: "/must-not-execute", environment: {}, diagnose: vi.fn() };
    expect(await prepareMobileRemoteRuntime({ ...input, platform: "win32" })).toBeUndefined();
    expect(
      await prepareMobileRemoteRuntime({
        ...input,
        platform: "darwin",
        architecture: "arm64",
        environment: { CODEXHOST_MOBILE_REMOTE: "0" },
      }),
    ).toBeUndefined();
  });
});
