import fs from "node:fs";
import path from "node:path";

import {
  executableExtensions,
  pathDirectories,
  type CommandInvocation,
} from "@codexhost/harness-discovery";

/**
 * Launcher handling for a `.cmd` shim in a UNC working directory.
 *
 * `cmd.exe` refuses a UNC current directory and silently falls back to
 * `%SystemRoot%`, so a batch shim must not be the launch path there. The native
 * installer's `omo.exe` needs none of this: Windows starts it directly from any
 * directory, including a UNC share.
 *
 * Only the npm package's generated shim is bypassed, and only when the shim,
 * the package manifest, and the declared JS entry all agree. An unrecognised
 * launcher is refused instead of being started in the wrong directory.
 */

/** The npm package that installs the `omo` CLI shim. */
export const OMO_NPM_PACKAGE = "omo-ai";

const OMO_SHIM_NAMES: ReadonlySet<string> = new Set(["omo.cmd", "omo-ai.cmd"]);

export function isWindowsUncDirectory(directory: string): boolean {
  return /^\\\\(?:\?\\UNC\\)?(?![?.]\\)[^\\]+\\[^\\]+(?:\\|$)/iu.test(
    path.win32.normalize(directory),
  );
}

export interface OmoUncLaunchDependencies {
  readText?(file: string): string | undefined;
  isFile?(file: string): boolean;
}

function text(file: string): string | undefined {
  try {
    return fs
      .readFileSync(file, "utf8")
      .replace(/^\uFEFF/u, "")
      .replaceAll("\r\n", "\n")
      .trim();
  } catch {
    return undefined;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// npm's generated wrapper for a JS bin target, in both PATH-ext variants.
function npmShim(target: string, pathExtFix = false): string {
  return `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
${pathExtFix ? "" : "  SET PATHEXT=%PATHEXT:;.JS;=;%\n"})

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ${pathExtFix ? "set PATHEXT=%PATHEXT:;.JS;=;% & " : ""}"%_prog%"  "%dp0%\\${target}" %*`;
}

function nodeOnPath(environment: NodeJS.ProcessEnv, fileExists: (file: string) => boolean): string {
  for (const directory of pathDirectories(environment, "win32")) {
    for (const extension of executableExtensions("node", "win32", environment)) {
      const suffix = extension.toLowerCase();
      const candidate = path.join(directory, `node${suffix}`);
      if (!fileExists(candidate)) continue;
      // Bare node must not skip a preferred batch shim or a file association.
      if (suffix !== ".exe" && suffix !== ".com") {
        throw new Error("OmO PATH Node launcher cannot safely bypass CMD in a UNC directory");
      }
      return candidate;
    }
  }
  return process.execPath;
}

function packageEntry(
  packageDirectory: string,
  manifest: Record<string, unknown>,
  fileExists: (file: string) => boolean,
): string | undefined {
  const bin = manifest.bin;
  let target: unknown;
  if (typeof bin === "string") target = bin;
  else if (typeof bin === "object" && bin !== null && !Array.isArray(bin)) {
    const entries = bin as Record<string, unknown>;
    target = entries.omo ?? entries["omo-ai"];
    if (target === undefined) {
      const values = Object.values(entries);
      if (values.length === 1) target = values[0];
    }
  }
  if (typeof target !== "string" || target.trim().length === 0) return undefined;
  const entry = path.resolve(packageDirectory, target);
  const relative = path.relative(packageDirectory, entry);
  // The declared entry must stay inside its package; a shim cannot point elsewhere.
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return fileExists(entry) ? entry : undefined;
}

/**
 * Turns a recognised npm `omo.cmd` launcher into a direct Node invocation for a
 * UNC working directory. Throws when the shim cannot be verified, so a batch
 * file never runs in `cmd.exe`'s fallback directory.
 */
export function omoUncNodeInvocation(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  dependencies: OmoUncLaunchDependencies = {},
): CommandInvocation {
  const readText = dependencies.readText ?? text;
  const fileExists = dependencies.isFile ?? isFile;
  const directory = path.dirname(command);
  const source = readText(command);
  if (
    path.isAbsolute(command) &&
    OMO_SHIM_NAMES.has(path.win32.basename(command).toLowerCase()) &&
    source !== undefined
  ) {
    const packageDirectory = path.join(directory, "node_modules", OMO_NPM_PACKAGE);
    try {
      const manifest: unknown = JSON.parse(
        readText(path.join(packageDirectory, "package.json")) ?? "",
      );
      if (
        typeof manifest === "object" &&
        manifest !== null &&
        "name" in manifest &&
        manifest.name === OMO_NPM_PACKAGE
      ) {
        const entry = packageEntry(packageDirectory, manifest, fileExists);
        if (entry) {
          const target = path.relative(directory, entry).replaceAll("/", "\\");
          if (target.length > 0 && [npmShim(target), npmShim(target, true)].includes(source)) {
            const localNode = path.join(directory, "node.exe");
            return {
              command: fileExists(localNode) ? localNode : nodeOnPath(environment, fileExists),
              arguments: [entry, ...arguments_],
              windowsVerbatimArguments: false,
            };
          }
        }
      }
    } catch {
      // An unreadable or unrecognised installation cannot bypass CMD.
    }
  }
  throw new Error(
    "OmO batch launcher cannot safely start in a UNC working directory. Use the native omo executable, an npm installation whose omo-ai package entry is intact, or a Host running inside WSL; custom omo or PATH Node batch launchers are not bypassed.",
  );
}
