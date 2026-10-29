import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type * as Updates from "@codexhost/update-manager";
import { windowsInstallerRecoveryUnavailable } from "@codexhost/update-manager";
import { createConsoleUpdates } from "../src/updates.js";
import { runUpdateCommand } from "../src/update-cli.js";
vi.mock("@codexhost/update-manager", async (original) => ({
  ...(await original<typeof Updates>()),
  windowsInstallerRecoveryUnavailable: vi.fn(async () => null),
}));
test.each(["npm", "windows-installer"] as const)(
  "Windows %s console/CLI starts once and still rejects missing original capability",
  async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "console-win-start-"));
    try {
      vi.mocked(windowsInstallerRecoveryUnavailable).mockResolvedValue(null);
      const state = path.join(root, "state"),
        statusPath = path.join(state, "update-1.2.4-test/status-v1.json");
      const status = {
        schemaVersion: 1 as const,
        version: "1.2.4",
        installation: kind,
        phase: "waiting-for-exit" as const,
        updatedAt: 1,
      };
      const prepare = vi.fn(async (o: Updates.CommonUpdateOptions) => {
        await mkdir(path.dirname(statusPath), { recursive: true });
        await writeFile(statusPath, JSON.stringify(status));
        await o.onPrepared?.({ version: status.version, installation: kind, statusPath });
        return {
          version: status.version,
          installation: kind,
          statusPath,
          requestPath: path.join(root, "request.json"),
          helperPath: path.join(root, "helper.exe"),
        };
      });
      const manager: Updates.BackgroundUpdateManager = {
        prepareNpm: prepare,
        prepareWindowsInstaller: prepare,
        prepareMacOsDmg: vi.fn(),
        start: vi.fn(async (p) => p),
        readStatus: async (file) => JSON.parse(await readFile(file, "utf8")),
      };
      const handedOff = vi.fn(),
        updates = createConsoleUpdates({
          platform: "win32",
          stateDirectory: state,
          environment: {
            CODEXHOST_NPM_PACKAGE_ROOT: root,
            CODEXHOST_NPM_NODE_PATH: process.execPath,
            CODEXHOST_NPM_CLI_PATH: path.join(root, "npm.js"),
            CODEXHOST_NPM_LAUNCHER_PATH: path.join(
              root,
              "node_modules/@codexhost/cli/bin/codexhost.js",
            ),
          },
          manager,
          waitForHandoff: true,
          onHandedOff: handedOff,
          fetchLatest: async () => ({
            version: "1.2.4",
            releaseNotes: null,
            releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.4",
            assets: [
              {
                name: "codexhost-1.2.4-windows-x64.exe",
                size: 10,
                digest: `sha256:${"ab".repeat(32)}`,
                downloadUrl:
                  "https://github.com/BytePioneer-AI/codex-host/releases/download/v1.2.4/codexhost-1.2.4-windows-x64.exe",
              },
            ],
          }),
        });
      const target = {
        distribution: {
          schemaVersion: 1 as const,
          version: "1.2.3",
          target: "windows-x64" as const,
          distribution: kind === "npm" ? ("npm" as const) : ("installer" as const),
        },
        appDirectory: path.join(root, "app"),
        runtimeDescriptorPath: path.join(root, "runtime.json"),
        codexhostRunning: false,
      };
      expect(await updates.check(target)).toMatchObject({
        installationAvailable: true,
        error: null,
      });
      const output = vi.fn();
      await runUpdateCommand(target, updates, output);
      expect(manager.start).toHaveBeenCalledOnce();
      expect(handedOff).toHaveBeenCalledOnce();
      expect(output.mock.calls.at(-1)?.[0]).toContain("installation is not complete");
      if (kind === "windows-installer") {
        vi.mocked(windowsInstallerRecoveryUnavailable).mockResolvedValue(
          "Use original directory: recovery capability missing",
        );
        expect(await updates.check(target)).toMatchObject({ installationAvailable: false });
        await expect(updates.start(target)).rejects.toMatchObject({ code: "unsupported" });
        expect(prepare).toHaveBeenCalledOnce();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
