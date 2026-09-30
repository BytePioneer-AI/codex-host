import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ZcodeError } from "./errors.js";

const DEFAULT_DARWIN_APP = "/Applications/ZCode.app";
const DEFAULT_LINUX_APP = "/opt/ZCode";

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
    await handle.read(headerBuf, 0, 16, 0);
    const headerSize = headerBuf.readUInt32LE(4);
    const jsonLen = headerBuf.readUInt32LE(12);
    // A corrupt header must not size the allocation.
    if (16 + jsonLen > (await handle.stat()).size) return undefined;
    const jsonBuf = Buffer.alloc(jsonLen);
    await handle.read(jsonBuf, 0, jsonLen, 16);
    const header = JSON.parse(jsonBuf.toString("utf8"));
    const pkg = header.files["package.json"];
    const pkgBuf = Buffer.alloc(pkg.size);
    await handle.read(pkgBuf, 0, pkg.size, 8 + headerSize + Number(pkg.offset));
    const parsed = JSON.parse(pkgBuf.toString("utf8"));
    if (typeof parsed?.productName !== "string" || typeof parsed?.version !== "string")
      return undefined;
    return {
      productName: parsed.productName.trim(),
      version: parsed.version.trim(),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function resolveDefaultApp(
  environment: NodeJS.ProcessEnv,
  platform: "darwin" | "win32" | "linux",
): Promise<string> {
  if (platform === "darwin") return DEFAULT_DARWIN_APP;
  if (platform === "linux") return DEFAULT_LINUX_APP;
  const candidates = [
    environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, "Programs", "ZCode"),
    environment.ProgramFiles && path.join(environment.ProgramFiles, "ZCode"),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (await isFile(path.join(candidate, "resources", "app.asar"))) return candidate;
  }
  return candidates[0] ?? "";
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
  if (!pkg?.productName || !pkg.version) throw missing();

  // Desktop's host spawns the CLI with its own executable. On macOS that is the Helper, a
  // background (LSUIElement) app; the main executable would show each CLI process in the Dock.
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
