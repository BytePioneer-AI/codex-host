import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createInstallationManager,
  fetchInstallationText,
  installationVersion,
  newerInstallationVersion,
  npmInstallation,
  runInstallationCommand,
  versionFromOutput,
} from "@codexhost/harness-discovery";
import { resolveKimiExecutable } from "./command.js";

export function createKimiInstallation(environment: NodeJS.ProcessEnv) {
  const executable = () => resolveKimiExecutable({ environment });
  const run = (args: string[], timeout?: number) =>
    runInstallationCommand(
      executable(),
      args,
      { ...environment, KIMI_CODE_NO_AUTO_UPDATE: "1" },
      timeout,
    );
  const nativeUpdaterAvailable = async () => {
    const file = await open(executable(), "r");
    try {
      const header = Buffer.alloc(4);
      await file.read(header, 0, 4, 0);
      const magic = header.toString("hex");
      if (
        !["cffaedfe", "cefaedfe", "cafebabe", "7f454c46"].includes(magic) &&
        !magic.startsWith("4d5a")
      )
        return false;
    } finally {
      await file.close();
    }
    // Kimi's public upgrade is interactive. Use its staging worker only when it
    // advertises manual updates, then let native startup perform the swap.
    return /--manual/.test(await run(["__update_download", "--help"]));
  };
  return createInstallationManager({
    async check() {
      const currentVersion = versionFromOutput(await run(["--version"]));
      const home = environment.KIMI_CODE_HOME ?? join(environment.HOME ?? homedir(), ".kimi-code");
      const region = await readFile(join(home, "region"), "utf8").catch(() => "");
      const base =
        region.trim() === "global"
          ? "https://code.kimi.ai/kimi-code"
          : "https://code.kimi.com/kimi-code";
      const latestVersion = installationVersion(await fetchInstallationText(`${base}/latest`));
      const npm = await npmInstallation(executable(), ["@moonshot-ai/kimi-code"], environment);
      const canUpdate = npm ? npm.canUpdate : await nativeUpdaterAvailable();
      return {
        currentVersion,
        latestVersion,
        updateAvailable: newerInstallationVersion(currentVersion, latestVersion),
        canUpdate,
        ...(!canUpdate
          ? { message: "Use the original installer to update this Kimi installation" }
          : {}),
      };
    },
    async update(state) {
      const npm = await npmInstallation(executable(), ["@moonshot-ai/kimi-code"], environment);
      if (npm) await npm.update(state.latestVersion);
      else {
        if (!(await nativeUpdaterAvailable()))
          throw new Error("Kimi native updater is unavailable");
        await run(["__update_download", state.latestVersion, "--manual"], 300_000);
        await run(["--version"]);
      }
    },
  });
}
