import {
  createInstallationManager,
  installationVersion,
  runInstallationCommand,
  versionFromOutput,
} from "@codexhost/harness-discovery";
import { resolveQoderExecutable } from "./qoder-command.js";

export function createQoderInstallation(environment: NodeJS.ProcessEnv, command?: string) {
  const run = (args: string[], timeout?: number) =>
    runInstallationCommand(
      resolveQoderExecutable({ environment, ...(command ? { command } : {}) }),
      args,
      environment,
      timeout,
    );
  return createInstallationManager({
    async check() {
      const currentVersion = versionFromOutput(await run(["--version"]));
      const output = await run(["update", "--check"]);
      const available = output.match(/Update available:\s*\S+\s*(?:->|\u2192)\s*(\S+)/i);
      if (available?.[1])
        return {
          currentVersion,
          latestVersion: installationVersion(available[1]),
          updateAvailable: true,
          canUpdate: true,
        };
      if (
        !/already\s+(?:on|at)\s+(?:the\s+)?latest|up.to.date|no updates?\s+available/i.test(output)
      )
        throw new Error("Qoder update check returned an unknown response");
      return {
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
        canUpdate: true,
      };
    },
    async update() {
      await run(["update"], 300_000);
    },
  });
}
