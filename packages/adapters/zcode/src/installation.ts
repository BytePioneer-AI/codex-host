import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ZcodeError } from "./errors.js";

export const DEFAULT_ZCODE_APP = "/Applications/ZCode.app";

/** Files of an installed ZCode Desktop and the native data root its CLI uses. */
export interface ZcodeInstallation {
  /** The App's Electron executable; with ELECTRON_RUN_AS_NODE=1 it is ZCode's own Node runtime. */
  runtime: string;
  /** CFBundleShortVersionString, reported to ZCode's client configuration service. */
  version: string;
  cli: string;
  builtinProviderConfig: string;
  personalProviderConfig: string;
  /** `{ZCODE_DATA_BASE_DIR || home}/.zcode/v2`, shared with ZCode Desktop. */
  dataRoot: string;
}

async function isFile(file: string) {
  return stat(file).then(
    (entry) => entry.isFile(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    },
  );
}

function plistString(plist: string, key: string): string | undefined {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, "u").exec(plist)?.[1]?.trim();
}

/**
 * The saved launch path (or CODEXHOST_ZCODE_APP) names the ZCode.app bundle. Provider config
 * locations follow ZCode's own environment contract, so an explicit native variable wins.
 */
export async function resolveInstallation(
  environment: NodeJS.ProcessEnv,
  app = environment.CODEXHOST_ZCODE_APP || DEFAULT_ZCODE_APP,
): Promise<ZcodeInstallation> {
  const missing = () =>
    new ZcodeError(
      "notInstalled",
      `ZCode Desktop was not found at ${app}; install it or set its application path`,
    );
  const plist = await readFile(path.join(app, "Contents", "Info.plist"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return "";
      throw error;
    },
  );
  const executable = plistString(plist, "CFBundleExecutable");
  const version = plistString(plist, "CFBundleShortVersionString");
  if (!executable || !version || path.basename(executable) !== executable) throw missing();
  const runtime = path.join(app, "Contents", "MacOS", executable);
  const resources = path.join(app, "Contents", "Resources");
  const cli = path.join(resources, "glm", "zcode.cjs");
  const builtinProviderConfig =
    environment.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ||
    path.join(resources, "config", "provider", "zcode-builtin.json");
  if (!(await isFile(runtime)) || !(await isFile(cli)) || !(await isFile(builtinProviderConfig)))
    throw missing();
  const dataRoot = path.join(
    environment.ZCODE_DATA_BASE_DIR?.trim() || environment.HOME || homedir(),
    ".zcode",
    "v2",
  );
  return {
    runtime,
    version,
    cli,
    builtinProviderConfig,
    personalProviderConfig:
      environment.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ||
      path.join(dataRoot, "provider_config.json"),
    dataRoot,
  };
}
