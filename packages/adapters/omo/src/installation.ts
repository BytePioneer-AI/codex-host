import {
  createInstallationManager,
  runInstallationCommand,
  type InstallationState,
} from "@codexhost/harness-discovery";
import { resolveOmoExecutable, type OmoExecutableInput } from "./command.js";

export const OMO_VERSION_TIMEOUT_MS = 15_000;

const MISSING_OMO =
  "The omo CLI was not found. Install omo from the official guide, or set CODEXHOST_OMO_COMMAND to its executable.";

const unverifiedUpdateNotice = {
  en: "The latest omo version and its update channel are not verified by this codexhost build. Check or update omo with its own installer; codexhost reports the installed CLI version only.",
  "zh-CN":
    "当前 codexhost 版本尚无法核实 omo 的最新版本与更新渠道。请使用 omo 自带的安装器检查或更新；codexhost 只报告已安装 CLI 的版本。",
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

export interface OmoInstallationDependencies {
  resolveExecutable?: (input: OmoExecutableInput) => string | undefined;
  runCommand?: typeof runInstallationCommand;
}

/**
 * Version checks read `omo --version` only. The native install channel and a
 * stable latest-version source are unverified, so v1 never offers an update
 * and never reads `~/.omo/install.json` (stale on real installations).
 */
export function createOmoInstallation(
  environment: NodeJS.ProcessEnv,
  command?: string,
  dependencies: OmoInstallationDependencies = {},
): (action: "check" | "update", confirmedVersion?: string) => Promise<InstallationState> {
  const resolveExecutable = dependencies.resolveExecutable ?? resolveOmoExecutable;
  const runCommand = dependencies.runCommand ?? runInstallationCommand;
  const run = (args: readonly string[]): Promise<string> => {
    const executable = resolveExecutable({
      environment,
      ...(command ? { command } : {}),
    });
    if (!executable) return Promise.reject(new Error(MISSING_OMO));
    return runCommand(executable, args, environment, OMO_VERSION_TIMEOUT_MS);
  };
  return createInstallationManager({
    async check() {
      const currentVersion = parseOmoVersion(await run(["--version"]));
      return {
        currentVersion,
        latestVersion: "Unknown",
        latestVersionKind: "unknown",
        updateAvailable: false,
        canUpdate: false,
        notice: unverifiedUpdateNotice,
      };
    },
    async update(): Promise<void> {
      throw new Error("codexhost cannot update omo yet; use omo's own installer.");
    },
  });
}
