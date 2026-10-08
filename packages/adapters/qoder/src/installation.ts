import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import {
  createInstallationManager,
  installationVersion,
  newerInstallationVersion,
  runInstallationCommand,
  versionFromOutput,
} from "@codexhost/harness-discovery";
import { resolveQoderExecutable } from "./qoder-command.js";
import type { QoderVariant } from "./qoder-runtime.js";

export function createQoderInstallation(
  environment: NodeJS.ProcessEnv,
  command?: string,
  variant: QoderVariant = "global",
) {
  const run = (args: string[], timeout?: number) =>
    runInstallationCommand(
      resolveQoderExecutable({ environment, variant, ...(command ? { command } : {}) }),
      args,
      environment,
      timeout,
    );
  return createInstallationManager({
    async check() {
      const currentVersion = versionFromOutput(await run(["--version"]));
      if (
        variant === "cn" &&
        !(await run(["update", "--help"]).catch(() => "")).includes("--check")
      )
        return {
          currentVersion,
          latestVersion: "Unknown",
          updateAvailable: false,
          canUpdate: false,
          messageCode: "qoder-check-unavailable",
          message:
            "This Qoder China release does not expose a non-installing update check. Use its original installer.",
        };
      const output = await run(["update", "--check"]);
      const available = output.match(/Update available:\s*\S+\s*(?:->|\u2192)\s*(\S+)/i);
      if (available?.[1])
        return {
          currentVersion,
          latestVersion: installationVersion(available[1]),
          updateAvailable: newerInstallationVersion(
            currentVersion,
            installationVersion(available[1]),
          ),
          canUpdate: true,
        };
      if (
        !/already\s+(?:on|at)\s+(?:the\s+)?latest|up.to.date|no updates?\s+available/i.test(output)
      ) {
        const diagnostic = `Qoder update check returned an unknown response: ${sanitizeDiagnosticTail(output)}`;
        // Local diagnostics only: redaction does not make native output safe for the UI.
        // Host must keep mapping this exception to its generic installation error.
        console.warn(diagnostic);
        throw new Error(diagnostic);
      }
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
