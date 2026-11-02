import fs from "node:fs";
import path from "node:path";

import {
  environmentValue,
  resolveHarnessExecutable,
  type CommandInvocation,
} from "@codexhost/harness-discovery";
import { findPiCliEntry } from "./command.js";

export function isWindowsUncDirectory(directory: string): boolean {
  return /^\\\\(?:\?\\UNC\\)?(?![?.]\\)[^\\]+\\[^\\]+(?:\\|$)/iu.test(
    path.win32.normalize(directory),
  );
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

function nodeOnPath(environment: NodeJS.ProcessEnv): string {
  return (
    resolveHarnessExecutable({ id: "node", command: "node.exe" }, { environment })?.executable ??
    process.execPath
  );
}

// Match the full generated wrappers so custom environment setup or arguments cannot be skipped.
function npmShim(target: string): string {
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
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`;
}

const standaloneNodeSetup =
  'IF EXIST "%LOCALAPPDATA%\\pi-node\\current\\node.exe" SET "node=%LOCALAPPDATA%\\pi-node\\current\\node.exe"';

function managedShim(standalone: boolean): string {
  return `@ECHO off
SETLOCAL
SET "node=node"
${standalone ? `${standaloneNodeSetup}\n` : ""}"%node%" "%~dp0pi-launcher.js" %*
SET "pi_exit_code=%ERRORLEVEL%"
IF "%pi_exit_code%"=="9009" (
  IF "%node%"=="node" (
    "%SystemRoot%\\System32\\where.exe" /Q node
    IF ERRORLEVEL 1 GOTO node_missing
  ) ELSE IF NOT EXIST "%node%" GOTO node_missing
)
EXIT /B %pi_exit_code%
:node_missing
ECHO Pi could not find Node.js. Install Node.js 22.19.0 or newer, or rerun the installer at https://pi.dev. 1>&2
EXIT /B %pi_exit_code%`;
}

/** Bypass CMD only for recognized Pi launchers; preserve the selected installation and its Node choice. */
export function piUncNodeInvocation(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): CommandInvocation {
  const directory = path.dirname(command);
  const source = text(command);
  if (
    path.isAbsolute(command) &&
    path.win32.basename(command).toLowerCase() === "pi.cmd" &&
    source !== undefined
  ) {
    const packageDirectory = path.join(
      directory,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    try {
      const manifest: unknown = JSON.parse(text(path.join(packageDirectory, "package.json")) ?? "");
      if (
        typeof manifest === "object" &&
        manifest !== null &&
        "name" in manifest &&
        manifest.name === "@earendil-works/pi-coding-agent"
      ) {
        const entry = findPiCliEntry(packageDirectory);
        if (entry && source === npmShim(path.relative(directory, entry).replaceAll("/", "\\"))) {
          const localNode = path.join(directory, "node.exe");
          return {
            command: isFile(localNode) ? localNode : nodeOnPath(environment),
            arguments: [entry, ...arguments_],
            windowsVerbatimArguments: false,
          };
        }
      }
    } catch {
      // A managed launcher has no adjacent npm package.
    }

    const launcher = path.join(directory, "pi-launcher.js");
    try {
      const marker: unknown = JSON.parse(
        text(path.join(path.dirname(directory), "install", "managed-install.json")) ?? "",
      );
      if (
        typeof marker === "object" &&
        marker !== null &&
        "kind" in marker &&
        marker.kind === "pi-managed-install" &&
        "schemaVersion" in marker &&
        marker.schemaVersion === 1 &&
        "layout" in marker &&
        marker.layout === "releases-v1" &&
        "entrypoint" in marker &&
        typeof marker.entrypoint === "object" &&
        marker.entrypoint !== null &&
        "type" in marker.entrypoint &&
        marker.entrypoint.type === "script" &&
        "path" in marker.entrypoint &&
        typeof marker.entrypoint.path === "string" &&
        path.isAbsolute(marker.entrypoint.path) &&
        path.resolve(marker.entrypoint.path).toLowerCase() ===
          path.resolve(command).toLowerCase() &&
        isFile(launcher) &&
        (source === managedShim(false) || source === managedShim(true))
      ) {
        const localAppData = environmentValue(environment, "LOCALAPPDATA");
        const standaloneNode = localAppData
          ? path.join(localAppData, "pi-node", "current", "node.exe")
          : undefined;
        return {
          command:
            source === managedShim(true) && standaloneNode && isFile(standaloneNode)
              ? standaloneNode
              : nodeOnPath(environment),
          // The native launcher reads current-version and sets PI_MANAGED_INSTALL_ROOT itself.
          arguments: [launcher, ...arguments_],
          windowsVerbatimArguments: false,
        };
      }
    } catch {
      // An unreadable or unrecognized installation must not run in CMD's fallback directory.
    }
  }
  throw new Error(
    "Pi batch launcher cannot safely start in a UNC working directory. Use a standard npm or managed Pi installation, a native Pi executable, or a Host running inside WSL; custom batch launchers are not bypassed.",
  );
}
