import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  inspectRemoteHostInstallation,
  installRemoteHost,
  uninstallRemoteHost,
} from "../src/remote-host-install.js";

async function executable(filePath: string): Promise<string> {
  await writeFile(filePath, "fixture\n", "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

async function regularFile(filePath: string): Promise<string> {
  await writeFile(filePath, "fixture\n", { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

describe("remote SSH Host installation", () => {
  it("uses the startup file read by non-interactive zsh SSH commands", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-zsh-"));
    try {
      const installed = await installRemoteHost({
        home,
        stockCodexPath: await executable(path.join(home, "stock-codex")),
        nodePath: await executable(path.join(home, "node")),
        shimPath: await executable(path.join(home, "codexhost-shim")),
        hostRuntimePath: await regularFile(path.join(home, "host-runtime.mjs")),
        platform: "darwin",
        environment: { HOME: home, SHELL: "/bin/zsh" },
      });

      expect(installed.profilePath).toBe(path.join(home, ".zshenv"));
      expect(await readFile(installed.profilePath, "utf8")).toContain("CODEX_INSTALL_DIR");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("installs an idempotent wrapper without replacing the existing Codex chain", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-install-"));
    const profilePath = path.join(home, ".zshrc");
    const stockCodexPath = await executable(path.join(home, "opencodex-codex"));
    const nodePath = await executable(path.join(home, "node"));
    const shimPath = await executable(path.join(home, "codexhost-shim"));
    const hostRuntimePath = await regularFile(path.join(home, "host-runtime.mjs"));
    const claudeCommand = await executable(path.join(home, "claude"));
    await writeFile(profilePath, "export EXISTING_SETTING=1\n", "utf8");

    try {
      const options = {
        home,
        profilePath,
        stockCodexPath,
        nodePath,
        shimPath,
        hostRuntimePath,
        claudeCommand,
        platform: "darwin" as const,
      };
      const first = await installRemoteHost(options);
      const second = await installRemoteHost(options);
      const wrapper = await readFile(first.wrapperPath, "utf8");
      const profile = await readFile(profilePath, "utf8");

      expect(second.wrapperPath).toBe(first.wrapperPath);
      expect(wrapper).toContain("# codexhost remote SSH wrapper v1");
      expect(wrapper).toContain(`CODEXHOST_STOCK_CODEX_PATH='${stockCodexPath}'`);
      expect(wrapper).toContain(`CODEXHOST_CLAUDE_COMMAND='${claudeCommand}'`);
      expect(wrapper).toContain(
        `CODEXHOST_DATA_DIR='${path.join(home, ".codexhost", "remote", "data")}'`,
      );
      expect(wrapper).toContain(`exec '${shimPath}' \"$@\"`);
      expect(profile).toContain("export EXISTING_SETTING=1");
      expect(profile.match(/>>> codexhost remote SSH >>>/gu)).toHaveLength(1);
      expect(profile).toContain(`export CODEX_INSTALL_DIR='${path.dirname(first.wrapperPath)}'`);
      expect(await readFile(stockCodexPath, "utf8")).toBe("fixture\n");
      await expect(inspectRemoteHostInstallation(options)).resolves.toMatchObject({
        state: "ready",
        stockCodexPath,
        profilePath,
        dataDirectory: path.join(home, ".codexhost", "remote", "data"),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uninstalls only managed files and removes its profile block", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-uninstall-"));
    const profilePath = path.join(home, ".zshrc");
    const options = {
      home,
      profilePath,
      stockCodexPath: await executable(path.join(home, "stock-codex")),
      nodePath: await executable(path.join(home, "node")),
      shimPath: await executable(path.join(home, "codexhost-shim")),
      hostRuntimePath: await executable(path.join(home, "host-runtime.mjs")),
      platform: "darwin" as const,
    };
    await writeFile(profilePath, "before=1\nafter=2\n", "utf8");

    try {
      const installed = await installRemoteHost(options);
      await uninstallRemoteHost(options);

      await expect(readFile(installed.wrapperPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(profilePath, "utf8")).toBe("before=1\nafter=2\n");
      expect(await readFile(options.stockCodexPath, "utf8")).toBe("fixture\n");
      await expect(inspectRemoteHostInstallation(options)).resolves.toMatchObject({
        state: "not-installed",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("remembers an explicit profile for later default reinstall and uninstall", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-profile-"));
    const profilePath = path.join(home, ".ssh-codexhost-env");
    const options = {
      home,
      profilePath,
      stockCodexPath: await executable(path.join(home, "stock-codex")),
      nodePath: await executable(path.join(home, "node")),
      shimPath: await executable(path.join(home, "codexhost-shim")),
      hostRuntimePath: await regularFile(path.join(home, "host-runtime.mjs")),
      platform: "darwin" as const,
      environment: { HOME: home, SHELL: "/bin/zsh" },
    };
    await writeFile(profilePath, "existing=1\n", "utf8");

    try {
      await installRemoteHost(options);
      const reinstalled = await installRemoteHost({
        home: options.home,
        stockCodexPath: options.stockCodexPath,
        nodePath: options.nodePath,
        shimPath: options.shimPath,
        hostRuntimePath: options.hostRuntimePath,
        platform: options.platform,
        environment: options.environment,
      });
      expect(reinstalled.profilePath).toBe(profilePath);

      await uninstallRemoteHost({
        home,
        platform: "darwin",
        environment: { HOME: home, SHELL: "/bin/zsh" },
      });
      expect(await readFile(profilePath, "utf8")).toBe("existing=1\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects changing the managed profile without uninstalling first", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-profile-change-"));
    const firstProfile = path.join(home, ".first-profile");
    const secondProfile = path.join(home, ".second-profile");
    const options = {
      home,
      profilePath: firstProfile,
      stockCodexPath: await executable(path.join(home, "stock-codex")),
      nodePath: await executable(path.join(home, "node")),
      shimPath: await executable(path.join(home, "codexhost-shim")),
      hostRuntimePath: await regularFile(path.join(home, "host-runtime.mjs")),
      platform: "darwin" as const,
    };

    try {
      await installRemoteHost(options);
      await expect(installRemoteHost({ ...options, profilePath: secondProfile })).rejects.toThrow(
        "different shell profile",
      );
      expect(await readFile(firstProfile, "utf8")).toContain("CODEX_INSTALL_DIR");
      await expect(readFile(secondProfile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an unmanaged remote Codex entrypoint", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-conflict-"));
    const installRoot = path.join(home, ".codexhost", "remote");
    const wrapperPath = path.join(installRoot, "bin", "codex");
    await mkdir(path.dirname(wrapperPath), { recursive: true });
    await writeFile(wrapperPath, "unmanaged\n", "utf8");

    try {
      await expect(
        installRemoteHost({
          home,
          installRoot,
          profilePath: path.join(home, ".zshrc"),
          stockCodexPath: await executable(path.join(home, "stock-codex")),
          nodePath: await executable(path.join(home, "node")),
          shimPath: await executable(path.join(home, "codexhost-shim")),
          hostRuntimePath: await executable(path.join(home, "host-runtime.mjs")),
          platform: "darwin",
        }),
      ).rejects.toThrow("unmanaged Codex entrypoint");
      expect(await readFile(wrapperPath, "utf8")).toBe("unmanaged\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a directory where an executable runtime file is required", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-executable-"));
    const nodeDirectory = path.join(home, "node-directory");
    await mkdir(nodeDirectory);

    try {
      await expect(
        installRemoteHost({
          home,
          stockCodexPath: await executable(path.join(home, "stock-codex")),
          nodePath: nodeDirectory,
          shimPath: await executable(path.join(home, "codexhost-shim")),
          hostRuntimePath: await regularFile(path.join(home, "host-runtime.mjs")),
          platform: "darwin",
        }),
      ).rejects.toThrow("Node runtime is not an executable file");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a manifest containing undeclared or relative paths", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-manifest-"));
    const installRoot = path.join(home, ".codexhost", "remote");
    await mkdir(installRoot, { recursive: true });
    await writeFile(
      path.join(installRoot, "manifest.json"),
      JSON.stringify({ format: 1, wrapperPath: "relative", unexpected: true }),
      "utf8",
    );

    try {
      await expect(
        inspectRemoteHostInstallation({ home, installRoot, platform: "darwin" }),
      ).rejects.toThrow("unsupported format");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
