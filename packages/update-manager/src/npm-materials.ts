import { execFile } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { CLI_PACKAGE, fileDigest, inspectNpmArchive, npmPlatformPackage } from "./npm-archive.js";
import { requireSemanticVersion } from "./status.js";

const execute = promisify(execFile);
export interface PreparedNpmArchive {
  path: string;
  sha256: string;
}
export interface PreparedNpmMaterials {
  unpacked_bytes: number;
  cache_path: string;
  user_config_path: string;
  global_config_path: string;
  cli: PreparedNpmArchive;
  platform: PreparedNpmArchive;
}
export interface PrepareNpmMaterialsOptions {
  nodePath: string;
  npmCliPath: string;
  version: string;
  platform: NodeJS.Platform;
  architecture: string;
  directory: string;
  installPrefix: string;
}
export interface NpmPreparationDependencies {
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function assertNpmStagingOutsidePrefix(
  directory: string,
  prefix: string,
): Promise<void> {
  if (!path.isAbsolute(directory) || !path.isAbsolute(prefix))
    throw new Error("npm material paths must be absolute");
  let ancestor = directory;
  let resolved: string;
  for (;;) {
    try {
      resolved = path.resolve(await realpath(ancestor), path.relative(ancestor, directory));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const relative = path.relative(await realpath(prefix), resolved);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
    throw new Error("npm preparation must be outside the installed prefix");
}

/** Fetch a closed two-package installation, without installing into any prefix. */
export async function prepareNpmMaterials(
  options: PrepareNpmMaterialsOptions,
  dependencies: NpmPreparationDependencies = {},
): Promise<PreparedNpmMaterials> {
  const version = requireSemanticVersion(options.version);
  const platformPackage = npmPlatformPackage(options.platform, options.architecture);
  if (
    ![options.directory, options.installPrefix, options.nodePath, options.npmCliPath].every(
      path.isAbsolute,
    )
  )
    throw new Error("npm material paths must be absolute");
  if (path.normalize(options.directory) !== options.directory || !path.basename(options.directory))
    throw new Error("npm material directory must be normalized");
  await assertNpmStagingOutsidePrefix(options.directory, options.installPrefix);
  const destination = path.join(
    await realpath(path.dirname(options.directory)),
    path.basename(options.directory),
  );
  const deadline = AbortSignal.timeout(dependencies.timeoutMs ?? 120_000);
  const signal = dependencies.signal ? AbortSignal.any([deadline, dependencies.signal]) : deadline;
  const environment = { ...(dependencies.environment ?? process.env) };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  const cache = path.join(destination, "cache");
  await mkdir(destination, { mode: 0o700 });
  const run = async (args: string[]): Promise<string> => {
    const execution = execute(
      options.nodePath,
      [
        options.npmCliPath,
        ...args,
        "--cache",
        cache,
        "--prefix",
        destination,
        "--workspaces=false",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--force=false",
        "--fetch-retries=0",
        "--fetch-timeout=30000",
        "--prefer-online",
        "--update-notifier=false",
      ],
      {
        cwd: destination,
        env: environment,
        encoding: "utf8",
        windowsHide: true,
        signal,
        killSignal: "SIGKILL",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    try {
      return (await execution).stdout;
    } catch (error) {
      const child = execution.child;
      if (child.pid && child.exitCode === null && child.signalCode === null)
        await once(child, "exit");
      throw error;
    }
  };
  try {
    const npmVersion = (await run(["--version"])).trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+/u.test(npmVersion) || Number(npmVersion.split(".")[0]) < 7)
      throw new Error("npm 7 or newer is required for the offline package-set contract");
    let unpacked_bytes = 0;
    const fetch = async (name: string): Promise<PreparedNpmArchive> => {
      const spec = `${name}@${version}`;
      const manifest = JSON.parse(await run(["view", spec, "--json"])) as {
        name?: unknown;
        version?: unknown;
        dist?: { integrity?: unknown };
      };
      const integrity = manifest.dist?.integrity;
      if (
        manifest.name !== name ||
        manifest.version !== version ||
        typeof integrity !== "string" ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)
      )
        throw new Error(`npm registry did not supply exact SHA-512 materials for ${spec}`);
      const result: unknown = JSON.parse(
        await run(["pack", spec, "--json", "--pack-destination", destination]),
      );
      const filename = `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;
      if (
        !Array.isArray(result) ||
        result.length !== 1 ||
        result[0]?.name !== name ||
        result[0]?.version !== version ||
        result[0]?.filename !== filename ||
        result[0]?.integrity !== integrity
      )
        throw new Error(`npm pack did not match ${spec}`);
      const file = path.join(destination, filename);
      const info = await lstat(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size <= 0 ||
        info.size > 512 * 1024 * 1024
      )
        throw new Error(`npm archive is not a bounded regular file: ${name}`);
      if (`sha512-${(await fileDigest(file, "sha512", signal)).toString("base64")}` !== integrity)
        throw new Error(`npm archive integrity mismatch: ${name}`);
      unpacked_bytes += await inspectNpmArchive(
        file,
        name,
        version,
        options.platform,
        options.architecture,
        signal,
      );
      return { path: file, sha256: (await fileDigest(file, "sha256", signal)).toString("hex") };
    };
    const cli = await fetch(CLI_PACKAGE);
    const platform = await fetch(platformPackage);
    const user_config_path = path.join(destination, "offline-user.npmrc");
    const global_config_path = path.join(destination, "offline-global.npmrc");
    await writeFile(user_config_path, "", { flag: "wx", mode: 0o600 });
    await writeFile(global_config_path, "", { flag: "wx", mode: 0o600 });
    return {
      cli,
      platform,
      unpacked_bytes,
      cache_path: cache,
      user_config_path,
      global_config_path,
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (signal.aborted) throw new Error("npm material preparation timed out", { cause: error });
    throw error;
  }
}

/** Same fixed offline contract used by the native npm executor (not a trial install). */
export function offlineNpmArguments(materials: PreparedNpmMaterials, prefix: string): string[] {
  return [
    "install",
    "--global",
    "--prefix",
    prefix,
    "--offline",
    "--ignore-scripts",
    "--omit=optional",
    "--force=false",
    "--no-audit",
    "--no-fund",
    "--update-notifier=false",
    "--package-lock=false",
    "--cache",
    materials.cache_path,
    "--userconfig",
    materials.user_config_path,
    "--globalconfig",
    materials.global_config_path,
    "--",
    materials.cli.path,
    materials.platform.path,
  ];
}
