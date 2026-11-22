import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createInstallationManager,
  fetchInstallationText,
  installationVersion,
  newerInstallationVersion,
  npmInstallation,
  runInstallationCommand,
  versionFromOutput,
} from "@codexhost/harness-discovery";
import { deepSeekNpxVersionFile, resolveDeepSeekCommand } from "./executable.js";
import {
  DEEPSEEK_NEWEST_VERIFIED_VERSION,
  DEEPSEEK_VERIFIED_VERSIONS,
} from "./generation-selector.js";

export function createDeepSeekInstallation(environment: NodeJS.ProcessEnv, command?: string) {
  let update: ((version: string) => Promise<void>) | undefined;
  return createInstallationManager({
    async check() {
      const invocation = resolveDeepSeekCommand(command, environment);
      if (!invocation) throw new Error("DeepSeek Harness is not installed");
      const currentVersion = versionFromOutput(
        await runInstallationCommand(
          invocation.command,
          [...invocation.arguments, "--version"],
          environment,
        ),
      );
      // Version discovery is independent of whether this installation can be updated.
      const metadata = JSON.parse(
        await fetchInstallationText("https://registry.npmjs.org/%40deepseek-ai%2Fdsh/latest"),
      ) as { version?: unknown };
      const latestVersion = installationVersion(metadata.version);
      const isNpx = invocation.kind === "npx";
      const npm = isNpx
        ? null
        : await npmInstallation(invocation.command, ["@deepseek-ai/dsh"], environment);
      update = isNpx
        ? async (version) => {
            const specifier = `@deepseek-ai/dsh@${version}`;
            const output = await runInstallationCommand(
              invocation.command,
              ["--yes", "--prefer-online", specifier, "--version"],
              environment,
              600_000,
            );
            if (versionFromOutput(output) !== version)
              throw new Error("DSH npx update did not select the requested version");
            const offline = await runInstallationCommand(
              invocation.command,
              ["--offline", "--no-install", specifier, "--version"],
              environment,
            );
            if (versionFromOutput(offline) !== version)
              throw new Error("DSH offline npx launch still selects a different version");

            // Publish the new launch spec only after its own cache is verified offline.
            const destination = deepSeekNpxVersionFile(environment);
            const temporary = `${destination}.${randomUUID()}.tmp`;
            await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
            try {
              await writeFile(temporary, `${version}\n`, { flag: "wx", mode: 0o600 });
              await rename(temporary, destination);
            } finally {
              await rm(temporary, { force: true }).catch(() => undefined);
            }
          }
        : npm?.update;
      const canUpdate = isNpx || (npm?.canUpdate ?? false);
      const updateAvailable = newerInstallationVersion(currentVersion, latestVersion);
      return {
        currentVersion,
        latestVersion,
        updateAvailable,
        canUpdate,
        ...(updateAvailable && !DEEPSEEK_VERIFIED_VERSIONS.includes(latestVersion)
          ? { latestVerifiedVersion: DEEPSEEK_NEWEST_VERIFIED_VERSION }
          : {}),
        ...(!canUpdate
          ? {
              messageCode: "deepseek-original-installer",
              notice: {
                en: "Update with the original installer. Python, desktop, and project-local installations are not upgraded through global npm.",
                "zh-CN":
                  "请使用原安装方式更新。Python、桌面应用及项目内安装不会通过全局 npm 更新。",
              },
              message:
                "Update with the original installer. Python, desktop, and project-local installations are not upgraded through global npm.",
            }
          : {}),
      };
    },
    async update(state) {
      if (!update) throw new Error("This DeepSeek installation requires a manual update");
      await update(state.latestVersion);
    },
  });
}
