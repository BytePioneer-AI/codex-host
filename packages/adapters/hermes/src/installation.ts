import { createInstallationManager, runInstallationCommand } from "@codexhost/harness-discovery";
import { resolveHermesExecutable } from "./command.js";

export function createHermesInstallation(environment: NodeJS.ProcessEnv, command?: string) {
  let executable: string;
  return createInstallationManager({
    async check() {
      executable = resolveHermesExecutable({ environment, ...(command ? { command } : {}) });
      const run = (args: string[]) => runInstallationCommand(executable, args, environment);
      const versionOutput = await run(["--version"]);
      const version = versionOutput.match(/^Hermes Agent v?([\w.+?-]{1,96})(?:\s|$)/m)?.[1];
      if (!version) throw new Error("Hermes returned an unknown version response");
      const help = await run(["update", "--help"]);
      if (!help.includes("--plan") || !help.includes("--check"))
        return {
          currentVersion: version,
          latestVersion: "Unknown",
          updateAvailable: false,
          canUpdate: false,
          messageCode: "hermes-update-plan-unavailable",
          message:
            "This Hermes release does not expose a safe update plan. Use the original installer.",
        };
      const plan = await run(["update", "--plan"]);
      const sha = plan.match(/Install:.* @ ([a-f0-9]{8,40})\)/i)?.[1];
      const currentVersion = `${version}${sha ? ` @ ${sha}` : ""}`;
      if (!/Install:\s*git\b/i.test(plan) || /NOT updatable in place/i.test(plan))
        return {
          currentVersion,
          latestVersion: "Unknown",
          updateAvailable: false,
          canUpdate: false,
          messageCode: "hermes-externally-managed",
          message:
            "This Hermes installation is managed externally. Update it through its desktop app, container, or original package manager.",
        };
      const output = await run(["update", "--check"]);
      const updateAvailable = /(?:selected release|update) available/i.test(output);
      if (!updateAvailable && !/up.to.date/i.test(output))
        throw new Error("Hermes update check returned an unknown response");
      const release = output.match(/Selected release available:\s*([\w.+-]+)/i)?.[1];
      const latestVersion = updateAvailable
        ? (release ?? "Tracking branch (new commits)")
        : currentVersion;
      // Do not compare source revisions as SemVer or restart a user's Gateway fleet.
      const root = versionOutput.match(/^Install directory:\s*(.+)$/m)?.[1]?.trim();
      const clean = root
        ? await runInstallationCommand(
            "git",
            ["-C", root, "status", "--porcelain"],
            environment,
          ).then(
            (output) => !output.trim(),
            () => false,
          )
        : false;
      const canUpdate =
        !!sha && clean && help.includes("--yes") && help.includes("--no-gateway-restart");
      return {
        currentVersion,
        latestVersion,
        updateAvailable,
        canUpdate,
        ...(updateAvailable && !release ? { latestVersionKind: "tracking-branch" as const } : {}),
        messageCode: canUpdate ? "hermes-update-channel" : "hermes-manual-update",
        message: canUpdate
          ? "Uses Hermes's configured update channel. Gateway restarts are deferred; existing processes keep their running code."
          : "Use the native updater manually. Safe non-interactive updates require a clean source checkout, commit identity, and Gateway restart deferral.",
      };
    },
    async update() {
      await runInstallationCommand(
        executable,
        ["update", "--yes", "--no-gateway-restart"],
        environment,
        300_000,
      );
    },
  });
}
