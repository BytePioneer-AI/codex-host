import {
  createInstallationManager,
  installationVersion,
  runInstallationCommand,
} from "@codexhost/harness-discovery";
import { cursorInvocation } from "./command.js";

export function createCursorInstallation(environment: NodeJS.ProcessEnv) {
  const run = (args: string[], timeout?: number) => {
    const invocation = cursorInvocation(environment, undefined, args);
    // The Windows launcher resolves to its bundled Node entrypoint; retain that prefix.
    return runInstallationCommand(invocation.command, invocation.arguments, environment, timeout);
  };
  return createInstallationManager({
    async check() {
      const state = JSON.parse(await run(["about", "--format", "json"])) as Record<string, unknown>;
      if (state.latestStatus !== "up_to_date" && state.latestStatus !== "update_available")
        throw new Error("Cursor update checks are disabled or unavailable");
      return {
        currentVersion: installationVersion(state.cliVersion),
        latestVersion: installationVersion(state.latestVersion),
        updateAvailable: state.latestStatus === "update_available",
        canUpdate: true,
      };
    },
    async update() {
      await run(["update"], 300_000);
    },
  });
}
