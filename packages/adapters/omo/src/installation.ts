import {
  createInstallationManager,
  newerInstallationVersion,
  runInstallationCommand,
  type InstallationState,
} from "@codexhost/harness-discovery";
import { resolveOmoExecutable, type OmoExecutableInput } from "./command.js";

/** Version read (`omo --version`). */
export const OMO_VERSION_TIMEOUT_MS = 15_000;
/** Non-mutating update probes (`omo update --help`, `omo update --dry-run`). */
export const OMO_UPDATE_PROBE_TIMEOUT_MS = 30_000;
/** Native updater bound; the Host caps installation mutations at 11 minutes. */
export const OMO_UPDATE_TIMEOUT_MS = 300_000;
/** Official install guide shown when automatic updates are unavailable. */
export const OMO_MANUAL_UPDATE_URL = "https://omo.dev/docs/install";

/**
 * `omo update` replaces a standalone installation in place. On 2026-11-26 (omo
 * 5.1.83) only its up-to-date branch was observed, so the self-replacing path is
 * unverified and checks never offer an automatic update. Flip this together with
 * recorded live evidence in CAPABILITIES.md (C3).
 */
export const OMO_UPDATE_CHANNEL_CONFIRMED = false;

const MISSING_OMO =
  "The omo CLI was not found. Install omo from the official guide, or set CODEXHOST_OMO_COMMAND to its executable.";

const unverifiedUpdateNotice = {
  en: "codexhost has not verified this installation's self-replacing updater. Update omo with its own installer; codexhost only reports the installed CLI version.",
  "zh-CN":
    "codexhost 尚未核实此安装的自替换更新器。请使用 omo 自带的安装器更新；codexhost 只报告已安装 CLI 的版本。",
};

const unavailableCheckNotice = {
  en: "This omo release does not expose a non-interactive update check. Use omo's own installer to check for updates.",
  "zh-CN": "此 omo 版本不提供非交互式更新检查。请使用 omo 自带的安装器检查更新。",
};

const unreadableStatusNotice = {
  en: "codexhost could not read omo's update status. The installed version is shown but the latest version is unknown; use omo's own installer to check.",
  "zh-CN":
    "codexhost 无法读取 omo 的更新状态。已显示当前安装版本，但最新版本未知；请使用 omo 自带的安装器检查。",
};

export class OmoVersionError extends Error {
  constructor() {
    super("omo --version did not report a recognizable version");
    this.name = "OmoVersionError";
  }
}

/** `omo 5.1.83 (engine: senpi 2026.11.23; scheme nodef)` reports 5.1.83. */
export function parseOmoVersion(output: string): string {
  const match = /(?:^|\s)omo\s+v?(\d+(?:\.\d+){1,3}(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?=\s|\(|$)/iu.exec(
    output.trim(),
  );
  const version = match?.[1];
  if (!version) throw new OmoVersionError();
  return version;
}

/**
 * `omo update --help` documents that `--dry-run`/`--print` print the update
 * command without running it. Only the up-to-date branch of that output was
 * observed, so recognition is deliberately narrow and fails closed.
 */
export type OmoUpdateProbe =
  | { status: "unsupported" }
  | { status: "unknown"; message?: string }
  | { status: "current"; version: string }
  | { status: "available" };

const OMO_NEWEST_RELEASE = /\bis the newest (?:stable |beta |preview )?release\b/iu;
const OMO_UPDATE_COMMAND =
  /get\.omo\.dev\/install\.(?:sh|ps1)\b|\bbun\s+(?:add|install)\s+(?:-g|--global)\s+omo-ai\b/iu;

export function parseOmoUpdateProbe(output: string): OmoUpdateProbe {
  const text = output.trim();
  if (OMO_NEWEST_RELEASE.test(text)) {
    try {
      return { status: "current", version: parseOmoVersion(text) };
    } catch {
      return { status: "unknown" };
    }
  }
  if (OMO_UPDATE_COMMAND.test(text)) return { status: "available" };
  return { status: "unknown" };
}

export interface OmoInstallationDependencies {
  resolveExecutable?: (input: OmoExecutableInput) => string | undefined;
  runCommand?: typeof runInstallationCommand;
  /** Override of the verified-channel gate; production keeps the default false. */
  updateChannelConfirmed?: boolean;
}

/**
 * Version checks read `omo --version` only (never `~/.omo/install.json`: stale on
 * real installations) plus the release's own non-mutating update probes. A stable
 * remote latest-version source does not exist, and the self-replacing updater is
 * unverified, so checks report the installed version and offer the manual route.
 */
export function createOmoInstallation(
  environment: NodeJS.ProcessEnv,
  command?: string,
  dependencies: OmoInstallationDependencies = {},
): (action: "check" | "update", confirmedVersion?: string) => Promise<InstallationState> {
  const resolveExecutable = dependencies.resolveExecutable ?? resolveOmoExecutable;
  const runCommand = dependencies.runCommand ?? runInstallationCommand;
  const channelConfirmed = dependencies.updateChannelConfirmed ?? OMO_UPDATE_CHANNEL_CONFIRMED;
  const run = (args: readonly string[], timeout: number): Promise<string> => {
    const executable = resolveExecutable({
      environment,
      ...(command ? { command } : {}),
    });
    if (!executable) return Promise.reject(new Error(MISSING_OMO));
    return runCommand(executable, args, environment, timeout);
  };
  const probeUpdate = async (): Promise<OmoUpdateProbe> => {
    let help: string;
    try {
      help = await run(["update", "--help"], OMO_UPDATE_PROBE_TIMEOUT_MS);
    } catch {
      return { status: "unsupported" };
    }
    if (!/\B--(?:dry-run|print)\b/u.test(help)) return { status: "unsupported" };
    try {
      return parseOmoUpdateProbe(await run(["update", "--dry-run"], OMO_UPDATE_PROBE_TIMEOUT_MS));
    } catch (error) {
      return {
        status: "unknown",
        ...(error instanceof Error ? { message: error.message } : {}),
      };
    }
  };
  const manualOnly = () => ({
    canUpdate: false as const,
    manualUpdateUrl: OMO_MANUAL_UPDATE_URL,
    messageCode: "omo-update-channel-unverified",
    notice: unverifiedUpdateNotice,
    message: "This omo installation's update channel is not verified; use the original installer.",
  });
  return createInstallationManager({
    async check() {
      const currentVersion = parseOmoVersion(await run(["--version"], OMO_VERSION_TIMEOUT_MS));
      const probe = await probeUpdate();
      if (probe.status === "unsupported")
        return {
          currentVersion,
          latestVersion: "Unknown",
          latestVersionKind: "unknown",
          updateAvailable: false,
          canUpdate: false,
          manualUpdateUrl: OMO_MANUAL_UPDATE_URL,
          messageCode: "omo-update-check-unavailable",
          notice: unavailableCheckNotice,
          message: "This omo release does not expose a non-interactive update check.",
        };
      if (probe.status === "unknown")
        return {
          currentVersion,
          latestVersion: "Unknown",
          latestVersionKind: "unknown",
          updateAvailable: false,
          canUpdate: false,
          manualUpdateUrl: OMO_MANUAL_UPDATE_URL,
          messageCode: "omo-update-status-unknown",
          notice: unreadableStatusNotice,
          message:
            probe.message ??
            "omo update --dry-run returned an unrecognized response; use the original installer.",
        };
      const latestVersion = probe.status === "current" ? probe.version : "Unknown";
      return {
        currentVersion,
        latestVersion,
        ...(probe.status === "available" ? { latestVersionKind: "unknown" as const } : {}),
        updateAvailable:
          probe.status === "available" || newerInstallationVersion(currentVersion, probe.version),
        ...(channelConfirmed ? { canUpdate: true } : manualOnly()),
      };
    },
    async update() {
      await run(["update"], OMO_UPDATE_TIMEOUT_MS);
    },
  });
}
