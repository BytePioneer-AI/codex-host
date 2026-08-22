import { spawn } from "node:child_process";
import { once } from "node:events";
import type * as FileSystemPromises from "node:fs/promises";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

const filesystemFault = vi.hoisted(() => ({
  renameDestination: null as string | null,
  renameFailuresRemaining: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FileSystemPromises>();
  return {
    ...original,
    async rename(
      oldPath: Parameters<typeof original.rename>[0],
      newPath: Parameters<typeof original.rename>[1],
    ) {
      if (
        filesystemFault.renameDestination === path.resolve(newPath.toString()) &&
        filesystemFault.renameFailuresRemaining > 0
      ) {
        filesystemFault.renameFailuresRemaining -= 1;
        const error = new Error("fixture manifest write failed") as NodeJS.ErrnoException;
        error.code = "ENOSPC";
        throw error;
      }
      return original.rename(oldPath, newPath);
    },
  };
});

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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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

  it("installs an idempotent native entrypoint without replacing the existing Codex chain", async () => {
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
      const profile = await readFile(profilePath, "utf8");

      expect(second.wrapperPath).toBe(first.wrapperPath);
      expect(second.entrypointSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect((await lstat(first.wrapperPath)).isFile()).toBe(true);
      expect(await readFile(first.wrapperPath)).toEqual(await readFile(shimPath));
      expect(profile).toContain(`export CODEXHOST_STOCK_CODEX_PATH='${stockCodexPath}'`);
      expect(profile).toContain(`export CODEXHOST_HOST_NODE_PATH='${nodePath}'`);
      expect(profile).toContain(`export CODEXHOST_HOST_RUNTIME_PATH='${hostRuntimePath}'`);
      expect(profile).toContain("export CODEXHOST_REMOTE_SSH_MANAGED='1'");
      expect(profile).toContain(`export CODEXHOST_CLAUDE_COMMAND='${claudeCommand}'`);
      expect(profile).toContain(
        `CODEXHOST_DATA_DIR='${path.join(home, ".codexhost", "remote", "data")}'`,
      );
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

  it.skipIf(process.platform === "win32")(
    "reports a managed entrypoint without execute permission as degraded",
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-entrypoint-mode-"));
      const options = {
        home,
        stockCodexPath: await executable(path.join(home, "stock-codex")),
        nodePath: await executable(path.join(home, "node")),
        shimPath: await executable(path.join(home, "codexhost-shim")),
        hostRuntimePath: await regularFile(path.join(home, "host-runtime.mjs")),
        platform: "darwin" as const,
      };

      try {
        const installed = await installRemoteHost(options);
        await chmod(installed.wrapperPath, 0o600);

        await expect(inspectRemoteHostInstallation(options)).resolves.toMatchObject({
          state: "degraded",
          issues: expect.arrayContaining(["managed native entrypoint is missing or modified"]),
        });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("rolls back a first installation when manifest publication fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-rollback-"));
    const installRoot = path.join(home, ".codexhost", "remote");
    const profilePath = path.join(home, ".zshenv");
    const originalProfile = "export EXISTING_SETTING=1\n";
    await writeFile(profilePath, originalProfile, "utf8");
    const options = {
      home,
      installRoot,
      profilePath,
      stockCodexPath: await executable(path.join(home, "stock-codex")),
      nodePath: await executable(path.join(home, "node")),
      shimPath: await executable(path.join(home, "codexhost-shim")),
      hostRuntimePath: await regularFile(path.join(home, "host-runtime.mjs")),
      platform: "darwin" as const,
    };
    const wrapperPath = path.join(installRoot, "bin", "codex");
    const manifestPath = path.join(installRoot, "manifest.json");

    try {
      filesystemFault.renameDestination = path.resolve(manifestPath);
      filesystemFault.renameFailuresRemaining = process.platform === "win32" ? 2 : 1;
      await expect(installRemoteHost(options)).rejects.toMatchObject({ code: "ENOSPC" });
      filesystemFault.renameDestination = null;
      filesystemFault.renameFailuresRemaining = 0;

      await expect(lstat(wrapperPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(manifestPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(profilePath, "utf8")).toBe(originalProfile);
      await expect(installRemoteHost(options)).resolves.toMatchObject({ wrapperPath, profilePath });
    } finally {
      filesystemFault.renameDestination = null;
      filesystemFault.renameFailuresRemaining = 0;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("restores the previous managed installation when upgrade publication fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-upgrade-rollback-"));
    const installRoot = path.join(home, ".codexhost", "remote");
    const profilePath = path.join(home, ".zshenv");
    await writeFile(profilePath, "export EXISTING_SETTING=1\n", "utf8");
    const initialOptions = {
      home,
      installRoot,
      profilePath,
      stockCodexPath: await executable(path.join(home, "stock-codex")),
      nodePath: await executable(path.join(home, "node-v1")),
      shimPath: await executable(path.join(home, "codexhost-shim-v1")),
      hostRuntimePath: await regularFile(path.join(home, "host-runtime-v1.mjs")),
      platform: "darwin" as const,
    };
    const wrapperPath = path.join(installRoot, "bin", "codex");
    const manifestPath = path.join(installRoot, "manifest.json");

    try {
      await installRemoteHost(initialOptions);
      const previousWrapper = await readFile(wrapperPath);
      const previousProfile = await readFile(profilePath);
      const previousManifest = await readFile(manifestPath);
      const nextShimPath = await executable(path.join(home, "codexhost-shim-v2"));
      await writeFile(nextShimPath, "replacement shim\n", "utf8");
      await chmod(nextShimPath, 0o755);
      const upgradeOptions = {
        ...initialOptions,
        nodePath: await executable(path.join(home, "node-v2")),
        shimPath: nextShimPath,
        hostRuntimePath: await regularFile(path.join(home, "host-runtime-v2.mjs")),
      };

      filesystemFault.renameDestination = path.resolve(manifestPath);
      filesystemFault.renameFailuresRemaining = process.platform === "win32" ? 2 : 1;
      await expect(installRemoteHost(upgradeOptions)).rejects.toMatchObject({ code: "ENOSPC" });
      filesystemFault.renameDestination = null;
      filesystemFault.renameFailuresRemaining = 0;

      expect(await readFile(wrapperPath)).toEqual(previousWrapper);
      expect(await readFile(profilePath)).toEqual(previousProfile);
      expect(await readFile(manifestPath)).toEqual(previousManifest);
      await expect(inspectRemoteHostInstallation(initialOptions)).resolves.toMatchObject({
        state: "ready",
      });
      await expect(installRemoteHost(upgradeOptions)).resolves.toMatchObject({
        shimPath: nextShimPath,
      });
      expect(await readFile(wrapperPath)).toEqual(await readFile(nextShimPath));
    } finally {
      filesystemFault.renameDestination = null;
      filesystemFault.renameFailuresRemaining = 0;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("diagnoses and migrates the legacy shell entrypoint", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-migrate-"));
    const installRoot = path.join(home, ".codexhost", "remote");
    const wrapperPath = path.join(installRoot, "bin", "codex");
    const profilePath = path.join(home, ".zshenv");
    const stockCodexPath = await executable(path.join(home, "stock-codex"));
    const nodePath = await executable(path.join(home, "node"));
    const shimPath = await executable(path.join(home, "codexhost-shim"));
    const hostRuntimePath = await regularFile(path.join(home, "host-runtime.mjs"));
    const dataDirectory = path.join(installRoot, "data");
    const manifest = {
      format: 1,
      wrapperPath,
      profilePath,
      stockCodexPath,
      nodePath,
      shimPath,
      hostRuntimePath,
      dataDirectory,
    };
    await mkdir(path.dirname(wrapperPath), { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(
      wrapperPath,
      [
        "#!/usr/bin/env sh",
        "# codexhost remote SSH wrapper v1",
        `export CODEXHOST_STOCK_CODEX_PATH='${stockCodexPath}'`,
        `exec '${shimPath}' \"$@\"`,
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );
    await writeFile(
      profilePath,
      [
        "# >>> codexhost remote SSH >>>",
        `export CODEX_INSTALL_DIR='${path.dirname(wrapperPath)}'`,
        "# <<< codexhost remote SSH <<<",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(installRoot, "manifest.json"),
      `${JSON.stringify(manifest)}\n`,
      "utf8",
    );

    try {
      const before = await inspectRemoteHostInstallation({ home, platform: "darwin" });
      expect(before.state).toBe("degraded");
      if (before.state === "degraded") {
        expect(before.issues).toContain(
          "managed entrypoint uses the legacy blocking shell wrapper; reinstall to migrate",
        );
      }

      await installRemoteHost({
        home,
        stockCodexPath,
        nodePath,
        shimPath,
        hostRuntimePath,
        platform: "darwin",
        environment: { HOME: home, SHELL: "/bin/zsh" },
      });

      expect(await readFile(wrapperPath)).toEqual(await readFile(shimPath));
      expect(await readFile(profilePath, "utf8")).toContain("CODEXHOST_HOST_RUNTIME_PATH");
      await expect(
        inspectRemoteHostInstallation({ home, platform: "darwin" }),
      ).resolves.toMatchObject({ state: "ready", issues: [] });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "lets a desktop-style background bootstrap return while the native entrypoint stays alive",
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-bootstrap-"));
      const profilePath = path.join(home, ".profile");
      const listenerScript = path.join(home, "listener.mjs");
      const listenerPidPath = path.join(home, "listener.pid");
      const logPath = path.join(home, "listener.log");
      await writeFile(
        listenerScript,
        [
          'import { writeFileSync } from "node:fs";',
          "writeFileSync(process.argv[2], String(process.pid));",
          "setInterval(() => undefined, 1_000);",
          "",
        ].join("\n"),
        "utf8",
      );
      let bootstrapProcessGroup: number | null = null;

      try {
        const installed = await installRemoteHost({
          home,
          profilePath,
          stockCodexPath: process.execPath,
          nodePath: process.execPath,
          shimPath: process.execPath,
          hostRuntimePath: await regularFile(path.join(home, "host-runtime.mjs")),
          platform: process.platform,
        });
        const command = [
          `(umask 077; mkdir -p -- ${shellQuote(path.join(home, "control"))})`,
          `&& nohup ${shellQuote(installed.wrapperPath)}`,
          shellQuote(listenerScript),
          shellQuote(listenerPidPath),
          `>${shellQuote(logPath)} 2>&1 &`,
        ].join(" ");
        const bootstrap = spawn(process.env.SHELL ?? "/bin/sh", ["-c", command], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        bootstrap.stdout.resume();
        bootstrap.stderr.resume();
        if (bootstrap.pid === undefined) throw new Error("Bootstrap process omitted its PID");
        bootstrapProcessGroup = bootstrap.pid;
        const [exitCode, signal] = (await Promise.race([
          once(bootstrap, "close"),
          delay(2_000).then(() => {
            throw new Error("Desktop-style bootstrap did not detach within 2 seconds");
          }),
        ])) as [number | null, NodeJS.Signals | null];
        expect({ exitCode, signal }).toEqual({ exitCode: 0, signal: null });

        let listenerPid: number | null = null;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const source = await readFile(listenerPidPath, "utf8").catch(() => null);
          if (source !== null) {
            listenerPid = Number.parseInt(source, 10);
            break;
          }
          await delay(25);
        }
        if (listenerPid === null) {
          const log = await readFile(logPath, "utf8").catch(() => "<log unavailable>");
          throw new Error(`Listener did not write its PID: ${log.trim()}`);
        }
        expect(() => process.kill(listenerPid, 0)).not.toThrow();
      } finally {
        if (bootstrapProcessGroup !== null) {
          try {
            process.kill(-bootstrapProcessGroup, "SIGTERM");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
          await delay(100);
        }
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("uses the installed digest to uninstall safely after the source shim is removed", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-missing-shim-"));
    const options = {
      home,
      stockCodexPath: await executable(path.join(home, "stock-codex")),
      nodePath: await executable(path.join(home, "node")),
      shimPath: await executable(path.join(home, "codexhost-shim")),
      hostRuntimePath: await regularFile(path.join(home, "host-runtime.mjs")),
      platform: "darwin" as const,
    };

    try {
      await installRemoteHost(options);
      await rm(options.shimPath);

      await expect(inspectRemoteHostInstallation(options)).resolves.toMatchObject({
        state: "degraded",
        issues: ["Shim is unavailable"],
      });
      await expect(uninstallRemoteHost(options)).resolves.toBeUndefined();
      await expect(
        readFile(path.join(home, ".codexhost", "remote", "bin", "codex")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses to uninstall an entrypoint that no longer matches its recorded digest", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-tampered-shim-"));
    const options = {
      home,
      stockCodexPath: await executable(path.join(home, "stock-codex")),
      nodePath: await executable(path.join(home, "node")),
      shimPath: await executable(path.join(home, "codexhost-shim")),
      hostRuntimePath: await regularFile(path.join(home, "host-runtime.mjs")),
      platform: "darwin" as const,
    };

    try {
      const installed = await installRemoteHost(options);
      await writeFile(installed.wrapperPath, "tampered\n", { mode: 0o700 });
      await rm(options.shimPath);

      await expect(inspectRemoteHostInstallation(options)).resolves.toMatchObject({
        state: "degraded",
        issues: expect.arrayContaining(["managed native entrypoint is missing or modified"]),
      });
      await expect(uninstallRemoteHost(options)).rejects.toThrow(
        "Refusing to remove a modified remote Codex entrypoint",
      );
      expect(await readFile(installed.wrapperPath, "utf8")).toBe("tampered\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps legacy digest-free manifests fail-closed when the source shim is missing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-legacy-digest-"));
    const installRoot = path.join(home, ".codexhost", "remote");
    const wrapperPath = path.join(installRoot, "bin", "codex");
    const profilePath = path.join(home, ".zshenv");
    const stockCodexPath = await executable(path.join(home, "stock-codex"));
    const nodePath = await executable(path.join(home, "node"));
    const shimPath = await executable(path.join(home, "codexhost-shim"));
    const hostRuntimePath = await regularFile(path.join(home, "host-runtime.mjs"));
    const dataDirectory = path.join(installRoot, "data");
    await mkdir(path.dirname(wrapperPath), { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(wrapperPath, await readFile(shimPath), { mode: 0o755 });
    await writeFile(
      profilePath,
      [
        "# >>> codexhost remote SSH >>>",
        `export CODEX_INSTALL_DIR='${path.dirname(wrapperPath)}'`,
        "# <<< codexhost remote SSH <<<",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(installRoot, "manifest.json"),
      `${JSON.stringify({
        format: 1,
        wrapperPath,
        profilePath,
        stockCodexPath,
        nodePath,
        shimPath,
        hostRuntimePath,
        dataDirectory,
      })}\n`,
      "utf8",
    );

    try {
      await rm(shimPath);
      await expect(
        inspectRemoteHostInstallation({ home, platform: "darwin" }),
      ).resolves.toMatchObject({
        state: "degraded",
        issues: expect.arrayContaining([
          "managed native entrypoint cannot be verified because the source Shim is unavailable",
        ]),
      });
      await expect(uninstallRemoteHost({ home, platform: "darwin" })).rejects.toThrow(
        "Refusing to remove an unverifiable remote Codex entrypoint",
      );
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
