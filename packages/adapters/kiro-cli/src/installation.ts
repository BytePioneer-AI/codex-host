import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  createInstallationManager,
  fetchInstallationText,
  installationVersion,
  newerInstallationVersion,
  runInstallationCommand,
  versionFromOutput,
} from "@codexhost/harness-discovery";
import { resolveKiroExecutable } from "./command.js";

// Query the same effective preferences and forced-policy flag as the native macOS updater.
const KIRO_UPDATE_POLICY_QUERY = `
ObjC.import("CoreFoundation");
var key = $("update.baseUrl"), domain = $("dev.kiro.cli");
var forced = Boolean($.CFPreferencesAppValueIsForced(key, domain));
var value = ObjC.unwrap(ObjC.castRefToObject($.CFPreferencesCopyAppValue(key, domain)));
JSON.stringify({forced: forced, value: typeof value === "string" ? value : null});
`;

export function createKiroInstallation(environment: NodeJS.ProcessEnv, command?: string) {
  let executable: string;
  let updateArgs: string[];
  return createInstallationManager({
    async check() {
      executable = resolveKiroExecutable({ environment, ...(command ? { command } : {}) });
      const run = (args: string[]) => runInstallationCommand(executable, args, environment);
      const currentVersion = versionFromOutput(await run(["--version"]));
      const help = await run(["update", "--help"]);
      const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
      const selected = await realpath(executable);
      let latestVersion: string;
      if (process.platform === "darwin") {
        // macOS has no --check. Read only metadata; never run update to probe it.
        let policy: { forced?: unknown; value?: unknown };
        try {
          policy = JSON.parse(
            await runInstallationCommand(
              "/usr/bin/osascript",
              ["-l", "JavaScript", "-e", KIRO_UPDATE_POLICY_QUERY],
              environment,
            ),
          ) as typeof policy;
          if (typeof policy?.forced !== "boolean") throw new Error("Invalid Kiro policy response");
        } catch {
          return {
            currentVersion,
            latestVersion: "Unknown",
            updateAvailable: false,
            canUpdate: false,
            message:
              "Could not determine Kiro's managed update policy. Use the native updater rather than checking a different release source.",
          };
        }
        // Ordinary user preferences in this domain are not an enforced MDM policy.
        const base =
          (policy.forced && typeof policy.value === "string" ? policy.value.trim() : "") ||
          environment.KIRO_DESKTOP_RELEASE_URL ||
          "https://prod.download.cli.kiro.dev/stable";
        const url = new URL(`${base.replace(/\/$/, "")}/index.json`);
        if (url.protocol !== "https:") throw new Error("Kiro update metadata requires HTTPS");
        const registry = JSON.parse(await fetchInstallationText(url.href)) as {
          versions?: {
            version: string;
            rollout?: { start?: number };
            packages?: {
              os?: string;
              architecture?: string;
              fileType?: string;
              channel?: string;
            }[];
          }[];
        };
        const versions = registry.versions
          ?.filter(
            (release) =>
              (!release.rollout?.start || release.rollout.start <= Date.now() / 1000) &&
              release.packages?.some(
                (pkg) =>
                  pkg.fileType === "dmg" &&
                  (!pkg.os || pkg.os === "macos") &&
                  (!pkg.channel || pkg.channel === "stable") &&
                  [
                    "universal",
                    process.arch === "arm64" ? "aarch64" : "x86_64",
                    process.arch,
                  ].includes(pkg.architecture ?? ""),
              ),
          )
          .map((release) => installationVersion(release.version));
        if (!versions?.length) throw new Error("Kiro update registry has no matching release");
        latestVersion = versions.reduce((a, b) => (newerInstallationVersion(a, b) ? b : a));
      } else {
        if (!help.includes("--check"))
          return {
            currentVersion,
            latestVersion: "Unknown",
            updateAvailable: false,
            canUpdate: false,
            message:
              "This Kiro CLI version does not expose a non-installing update check. Use its original installer.",
          };
        const output = await run(["update", "--check"]);
        const available =
          output.match(/\b\d+(?:\.\d+){1,3}\s*(?:->|→)\s*v?(\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?)/) ??
          output.match(
            /(?:new version(?: of Kiro CLI)? (?:is )?available|update available|latest version(?: is)?)\s*[:=]?\s*v?(\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?)/i,
          );
        if (
          !available &&
          !/up.to.date|already.*latest|no updates? (?:are )?available/i.test(output)
        )
          throw new Error("Kiro update check returned an unknown response");
        latestVersion = available ? installationVersion(available[1]) : currentVersion;
      }
      const native =
        process.platform === "darwin"
          ? ["/Applications", path.join(home, "Applications")].some(
              (root) =>
                selected === path.join(root, "Kiro CLI.app", "Contents", "MacOS", "kiro-cli"),
            )
          : process.platform === "linux"
            ? selected === path.join(home, ".local", "bin", "kiro-cli")
            : !!environment.LOCALAPPDATA &&
              selected.startsWith(path.join(environment.LOCALAPPDATA, "Kiro-Cli") + path.sep);
      const canUpdate =
        native && (process.platform !== "darwin" || help.includes("--non-interactive"));
      updateArgs = ["update", ...(help.includes("--non-interactive") ? ["--non-interactive"] : [])];
      return {
        currentVersion,
        latestVersion,
        updateAvailable: newerInstallationVersion(currentVersion, latestVersion),
        canUpdate,
        ...(!canUpdate
          ? {
              message:
                "Use the original package manager or installer. Package-managed and custom Kiro installations are not updated here.",
            }
          : {}),
      };
    },
    async update() {
      await runInstallationCommand(executable, updateArgs, environment, 300_000);
    },
  });
}
