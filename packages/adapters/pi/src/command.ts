import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import {
  resolveHarnessExecutable,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export { withNodeRuntimeOnPath } from "@codexhost/harness-discovery";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_PACKAGE_PATH = path.join("node_modules", "@earendil-works", "pi-coding-agent");

export interface PiExecutableDependencies {
  platform: NodeJS.Platform;
  homeDirectory: string;
  isExecutable(filePath: string): boolean;
}

export const piDiscoverySpec: HarnessDiscoverySpec = {
  id: "pi",
  command: "pi",
  commandEnvironmentVariable: "PI_COMMAND",
  installRoots: {
    posix: [
      "~/.npm-global/bin",
      "~/.local/bin",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
    windows: ["${APPDATA}/npm", "~/.local/bin", VERSION_MANAGER_ROOTS],
  },
};

export function resolvePiExecutable(
  input: {
    command?: string;
    environment: NodeJS.ProcessEnv;
  },
  dependencies: Partial<PiExecutableDependencies> = {},
): string {
  const resolution = resolveHarnessExecutable(
    piDiscoverySpec,
    {
      ...(input.command ? { command: input.command } : {}),
      environment: input.environment,
      ...(dependencies.platform ? { platform: dependencies.platform } : {}),
      ...(dependencies.homeDirectory ? { homeDirectory: dependencies.homeDirectory } : {}),
    },
    { ...(dependencies.isExecutable ? { isExecutable: dependencies.isExecutable } : {}) },
  );
  return resolution?.executable ?? input.command ?? input.environment.PI_COMMAND ?? "pi";
}

/** Find the package backing the executable selected by the Pi Harness resolver. */
export function findPiPackageDirectory(executable: string): string | undefined {
  let directory = path.dirname(executable);
  while (true) {
    for (const candidate of [directory, path.join(directory, PI_PACKAGE_PATH)]) {
      try {
        const manifest: unknown = JSON.parse(
          fs.readFileSync(path.join(candidate, "package.json"), "utf8"),
        );
        if (
          typeof manifest === "object" &&
          manifest !== null &&
          "name" in manifest &&
          manifest.name === PI_PACKAGE_NAME
        ) {
          return candidate;
        }
      } catch {
        // Keep looking through the executable's install roots and npm shim directories.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Resolve Pi's declared JavaScript CLI entry instead of trying to execute a Windows .cmd shim via Node. */
export function findPiCliEntry(packageDirectory: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
    );
    if (typeof manifest !== "object" || manifest === null || !("bin" in manifest)) return undefined;
    const bin = manifest.bin;
    const entry =
      typeof bin === "string"
        ? bin
        : typeof bin === "object" && bin !== null && "pi" in bin
          ? bin.pi
          : undefined;
    if (typeof entry !== "string" || !entry.trim()) return undefined;
    const resolved = path.resolve(packageDirectory, entry);
    const relative = path.relative(packageDirectory, resolved);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      !fs.statSync(resolved).isFile()
    ) {
      return undefined;
    }
    return resolved;
  } catch {
    return undefined;
  }
}

function isFilesystemRoot(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  return resolved === path.parse(resolved).root;
}

function writableDirectory(candidate: string | undefined): string | undefined {
  if (!candidate || !path.isAbsolute(candidate) || isFilesystemRoot(candidate)) return undefined;
  try {
    if (!fs.statSync(candidate).isDirectory()) return undefined;
    fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

export function resolvePiInspectCwd(
  inputCwd: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof inputCwd === "string" && inputCwd.length > 0 && !isFilesystemRoot(inputCwd)) {
    return path.resolve(inputCwd);
  }
  const candidates = [environment.USERPROFILE, environment.HOME, homedir(), tmpdir()];
  for (const candidate of candidates) {
    const usable = writableDirectory(candidate);
    if (usable) return usable;
  }
  return inputCwd && inputCwd.length > 0 ? path.resolve(inputCwd) : process.cwd();
}
