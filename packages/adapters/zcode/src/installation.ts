import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ZcodeError } from "./errors.js";

export const DEFAULT_ZCODE_APP: Readonly<Record<"darwin" | "win32" | "linux", string>> =
  Object.freeze({
    darwin: "/Applications/ZCode.app",
    win32: "%LOCALAPPDATA%\\Programs\\ZCode",
    linux: "/opt/ZCode",
  });

/** Files of an installed ZCode Desktop and the native data root its CLI uses. */
export interface ZcodeInstallation {
  /** The CLI runtime executable (Electron Helper on macOS, main executable on Windows/Linux). */
  runtime: string;
  /** The App version from app.asar package.json, reported to ZCode's client configuration service. */
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

/**
 * Reads productName and version from an Electron app.asar file.
 * Format:
 * - bytes 4-7: uint32 LE header pickle size
 * - bytes 12-15: uint32 LE header JSON length
 * - offset 16: header JSON string of length jsonLen
 * - files["package.json"]: { size, offset }
 * - content offset: 8 + headerSize + Number(offset)
 */
async function readPackageJsonFromAsar(
  asarPath: string,
): Promise<{ productName: string; version: string } | undefined> {
  let handle;
  try {
    handle = await open(asarPath, "r");
    const headerBuf = Buffer.alloc(16);
    const { bytesRead: headerBytes } = await handle.read(headerBuf, 0, 16, 0);
    if (headerBytes < 16) return undefined;
    const headerSize = headerBuf.readUInt32LE(4);
    const jsonLen = headerBuf.readUInt32LE(12);
    if (jsonLen === 0 || jsonLen > headerSize) return undefined;
    const jsonBuf = Buffer.alloc(jsonLen);
    const { bytesRead: jsonBytes } = await handle.read(jsonBuf, 0, jsonLen, 16);
    if (jsonBytes < jsonLen) return undefined;
    const header = JSON.parse(jsonBuf.toString("utf8"));
    const pkgEntry = header?.files?.["package.json"];
    if (!pkgEntry || typeof pkgEntry.size !== "number" || pkgEntry.offset === undefined)
      return undefined;
    const pkgBuf = Buffer.alloc(pkgEntry.size);
    const contentOffset = 8 + headerSize + Number(pkgEntry.offset);
    const { bytesRead: pkgBytes } = await handle.read(pkgBuf, 0, pkgEntry.size, contentOffset);
    if (pkgBytes < pkgEntry.size) return undefined;
    const pkg = JSON.parse(pkgBuf.toString("utf8"));
    if (typeof pkg?.productName !== "string" || typeof pkg?.version !== "string") return undefined;
    return {
      productName: pkg.productName.trim(),
      version: pkg.version.trim(),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function resolveDefaultApp(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string> {
  if (platform === "darwin") return DEFAULT_ZCODE_APP.darwin;
  if (platform === "linux") return DEFAULT_ZCODE_APP.linux;
  if (platform === "win32") {
    const userPath = environment.LOCALAPPDATA
      ? path.join(environment.LOCALAPPDATA, "Programs", "ZCode")
      : undefined;
    const machinePath = environment.ProgramFiles
      ? path.join(environment.ProgramFiles, "ZCode")
      : undefined;
    if (userPath && (await isFile(path.join(userPath, "resources", "app.asar")))) {
      return userPath;
    }
    if (machinePath && (await isFile(path.join(machinePath, "resources", "app.asar")))) {
      return machinePath;
    }
    if (userPath && (await stat(userPath).then(() => true, () => false))) {
      return userPath;
    }
    if (machinePath && (await stat(machinePath).then(() => true, () => false))) {
      return machinePath;
    }
    return userPath || machinePath || DEFAULT_ZCODE_APP.win32;
  }
  throw new ZcodeError("notInstalled", `ZCode Desktop is not supported on ${platform}`);
}

/**
 * Resolves an installed ZCode Desktop on macOS, Windows, or Linux.
 * The saved launch path (or CODEXHOST_ZCODE_APP) wins; otherwise the platform default is used.
 */
export async function resolveInstallation(
  environment: NodeJS.ProcessEnv,
  app?: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ZcodeInstallation> {
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
    throw new ZcodeError("notInstalled", `ZCode Desktop is not supported on ${platform}`);
  }
  const explicitApp = app?.trim() || environment.CODEXHOST_ZCODE_APP?.trim();
  const targetApp = explicitApp || (await resolveDefaultApp(environment, platform));

  const missing = () =>
    new ZcodeError(
      "notInstalled",
      `ZCode Desktop was not found at ${targetApp}; install it or set its application path`,
    );

  const resources =
    platform === "darwin"
      ? path.join(targetApp, "Contents", "Resources")
      : path.join(targetApp, "resources");

  const pkg = await readPackageJsonFromAsar(path.join(resources, "app.asar"));
  if (!pkg?.productName || !pkg?.version) throw missing();

  let runtime: string;
  if (platform === "darwin") {
    runtime = path.join(
      targetApp,
      "Contents",
      "Frameworks",
      `${pkg.productName} Helper.app`,
      "Contents",
      "MacOS",
      `${pkg.productName} Helper`,
    );
  } else if (platform === "win32") {
    runtime = path.join(targetApp, `${pkg.productName}.exe`);
  } else {
    const linuxExecutableName = pkg.productName.toLowerCase().replace(/\s+/g, "-");
    runtime = path.join(targetApp, linuxExecutableName);
  }

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
    version: pkg.version,
    cli,
    builtinProviderConfig,
    personalProviderConfig:
      environment.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ||
      path.join(dataRoot, "provider_config.json"),
    dataRoot,
  };
}
