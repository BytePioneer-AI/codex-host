import { execFile } from "node:child_process";
import path from "node:path";

const CLI_PACKAGE = "@codexhost/cli";
const VIEW_TIMEOUT_MS = 30_000;
const PREFETCH_TIMEOUT_MS = 10 * 60_000;
/** A registry that lacks a version is asked again after this long; mirrors sync within hours. */
const NOT_YET_AVAILABLE_TTL_MS = 5 * 60_000;

/** The npm installation that an update replaces, run with the same npm and configuration. */
export interface NpmReleaseTarget {
  nodePath: string;
  npmCliPath: string;
  /** The platform package this installation runs. */
  packageRoot: string;
  version: string;
}

export interface NpmCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type NpmCommandRunner = (
  target: NpmReleaseTarget,
  arguments_: readonly string[],
  timeoutMs: number,
) => Promise<NpmCommandResult>;

/** The packages an npm update installs: the CLI and the platform package this installation runs. */
export function npmReleasePackages(packageRoot: string, version: string): string[] {
  const name = path.basename(packageRoot);
  if (path.basename(path.dirname(packageRoot)) !== "@codexhost" || !/^cli-[a-z0-9-]+$/u.test(name))
    throw new Error(`Unknown platform package path: ${packageRoot}`);
  return [`${CLI_PACKAGE}@${version}`, `@codexhost/${name}@${version}`];
}

export const runNpmCommand: NpmCommandRunner = (target, arguments_, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      target.nodePath,
      [target.npmCliPath, ...arguments_],
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false" },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

function firstErrorLine(result: NpmCommandResult): string {
  const line = result.stderr
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find((value) => /^npm (error|ERR!)/u.test(value) && !/A complete log/u.test(value));
  return (line ?? result.stderr.trim().split(/\r?\n/u).at(-1) ?? "").slice(0, 200);
}

function missingFromRegistry(result: NpmCommandResult): boolean {
  return /\b(E404|ETARGET)\b/u.test(result.stderr);
}

/**
 * Whether the registry this npm uses can install the release now. A mirror may lag the
 * GitHub Release, and it syncs the CLI and each platform package separately.
 * Rejects when the registry cannot be asked.
 */
async function releaseInstallable(
  target: NpmReleaseTarget,
  run: NpmCommandRunner,
): Promise<boolean> {
  const results = await Promise.all(
    npmReleasePackages(target.packageRoot, target.version).map((spec) =>
      run(target, ["view", spec, "version"], VIEW_TIMEOUT_MS),
    ),
  );
  for (const result of results) {
    if (result.code === 0) {
      if (result.stdout.trim() !== target.version) return false;
    } else if (missingFromRegistry(result)) {
      return false;
    } else {
      throw new Error(`Could not query the npm registry: ${firstErrorLine(result)}`);
    }
  }
  return true;
}

/**
 * Downloads and verifies the release into the npm cache, so installing it after the services
 * stop does not depend on the registry. Fails without side effects on the installation.
 */
export async function prefetchNpmRelease(
  target: NpmReleaseTarget,
  run: NpmCommandRunner = runNpmCommand,
): Promise<void> {
  const result = await run(
    target,
    ["cache", "add", ...npmReleasePackages(target.packageRoot, target.version)],
    PREFETCH_TIMEOUT_MS,
  );
  if (result.code === 0) return;
  if (missingFromRegistry(result))
    throw new Error(`npm registry does not have codexhost ${target.version} yet; retry later`);
  throw new Error(`npm could not download the update: ${firstErrorLine(result)}`);
}

export interface NpmReleaseAvailability {
  installable(target: NpmReleaseTarget): Promise<boolean>;
}

/** Shares one registry query between concurrent checks and remembers its answer. */
export function createNpmReleaseAvailability(
  run: NpmCommandRunner = runNpmCommand,
  now: () => number = Date.now,
): NpmReleaseAvailability {
  const answers = new Map<string, { result: Promise<boolean>; settledAt?: number }>();
  return Object.freeze({
    installable(target: NpmReleaseTarget): Promise<boolean> {
      const key = `${target.npmCliPath}\0${target.packageRoot}\0${target.version}`;
      const cached = answers.get(key);
      if (
        cached &&
        (cached.settledAt === undefined || now() - cached.settledAt < NOT_YET_AVAILABLE_TTL_MS)
      )
        return cached.result;
      const entry: { result: Promise<boolean>; settledAt?: number } = {
        result: releaseInstallable(target, run),
      };
      answers.set(key, entry);
      entry.result.then(
        (installable) => {
          // A published version stays published; only a missing one is asked again.
          if (!installable) entry.settledAt = now();
        },
        () => {
          if (answers.get(key) === entry) answers.delete(key);
        },
      );
      return entry.result;
    },
  });
}
