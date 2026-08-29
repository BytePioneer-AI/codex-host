import os from "node:os";

import {
  environmentValue,
  executableExtensions,
  isExecutableFile,
  pathDirectories,
  targetPath,
} from "./environment.js";
import { versionManagerBinaryDirectories } from "./version-managers.js";

/**
 * Sentinel install root that expands to every Node.js version-manager binary
 * directory. Place it in `installRoots` to control its search priority.
 */
export const VERSION_MANAGER_ROOTS = "<version-managers>";

/**
 * Everything a harness has to declare about where it can be found. Discovery
 * mechanics — PATH parsing, Windows extensions, version-manager layouts — are
 * shared and live in this package.
 */
export interface HarnessDiscoverySpec {
  readonly id: string;
  /** Default command name, used when nothing is configured. */
  readonly command: string;
  /** Environment variable holding an explicit command or absolute path. */
  readonly commandEnvironmentVariable?: string;
  /**
   * Directories searched, in order, after PATH — and only when no command is
   * configured. Supports a leading `~` and `${VARIABLE}` substitution.
   */
  readonly installRoots?: {
    readonly posix?: readonly string[];
    readonly windows?: readonly string[];
  };
  /**
   * Rewrites a matched candidate before it is checked, e.g. preferring a
   * native executable over the npm `.cmd` shim that sits beside it. Returning
   * `undefined` rejects the candidate.
   */
  readonly runnableCandidate?: (
    candidate: string,
    context: RunnableCandidateContext,
  ) => string | undefined;
}

export interface RunnableCandidateContext {
  readonly platform: NodeJS.Platform;
  readonly isExecutable: (candidate: string) => boolean;
}

export interface HarnessDiscoveryInput {
  readonly command?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
}

export interface HarnessDiscoveryDependencies {
  readonly isExecutable?: (candidate: string) => boolean;
  readonly subdirectories?: (directory: string) => string[];
}

export type HarnessCandidateSource = "configured" | "path" | "install-root";

export interface HarnessCandidate {
  readonly candidate: string;
  readonly source: HarnessCandidateSource;
}

export interface HarnessResolution {
  readonly executable: string;
  readonly source: HarnessCandidateSource;
}

/** Extensions probed inside install roots, where the command name is bare. */
function installRootExtensions(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [".exe", ".cmd"] : [""];
}

function resolveHomeDirectory(input: HarnessDiscoveryInput): string {
  return (
    input.homeDirectory ??
    environmentValue(input.environment, "HOME") ??
    environmentValue(input.environment, "USERPROFILE") ??
    os.homedir()
  );
}

function templateVariables(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): Record<string, string> {
  const pathFlavor = targetPath(platform);
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA:
      environmentValue(environment, "APPDATA") ?? pathFlavor.join(home, "AppData", "Roaming"),
    LOCALAPPDATA:
      environmentValue(environment, "LOCALAPPDATA") ?? pathFlavor.join(home, "AppData", "Local"),
  };
}

function joinTemplate(platform: NodeJS.Platform, value: string): string {
  const pathFlavor = targetPath(platform);
  const segments = value.split("/");
  const head = segments[0] ?? "";
  const tail = segments.slice(1);
  if (head === "") return pathFlavor.join(pathFlavor.sep, ...tail);
  return tail.length === 0 ? head : pathFlavor.join(head, ...tail);
}

function expandInstallRoot(
  template: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string | undefined {
  const variables = templateVariables(environment, platform, home);
  let unresolved = false;
  const substituted = template
    .replace(/^~(?=\/|$)/u, home)
    .replace(/\$\{(\w+)\}/gu, (_match, name: string) => {
      const value = variables[name] ?? environmentValue(environment, name);
      if (value === undefined || value === "") {
        unresolved = true;
        return "";
      }
      return value;
    });
  return unresolved ? undefined : joinTemplate(platform, substituted);
}

function installRootDirectories(
  spec: HarnessDiscoverySpec,
  input: HarnessDiscoveryInput,
  dependencies: HarnessDiscoveryDependencies,
  platform: NodeJS.Platform,
  home: string,
): string[] {
  const templates =
    (platform === "win32" ? spec.installRoots?.windows : spec.installRoots?.posix) ?? [];
  const directories: string[] = [];
  for (const template of templates) {
    if (template === VERSION_MANAGER_ROOTS) {
      directories.push(
        ...versionManagerBinaryDirectories({
          platform,
          environment: input.environment,
          home,
          ...(dependencies.subdirectories ? { subdirectories: dependencies.subdirectories } : {}),
        }),
      );
      continue;
    }
    const directory = expandInstallRoot(template, input.environment, platform, home);
    if (directory !== undefined) directories.push(directory);
  }
  return directories;
}

/**
 * Every path that would be probed, in order. Exported so diagnostics can show
 * the full search instead of only its outcome.
 */
export function harnessCandidates(
  spec: HarnessDiscoverySpec,
  input: HarnessDiscoveryInput,
  dependencies: HarnessDiscoveryDependencies = {},
): HarnessCandidate[] {
  const platform = input.platform ?? process.platform;
  const pathFlavor = targetPath(platform);
  const configured =
    input.command ??
    (spec.commandEnvironmentVariable
      ? environmentValue(input.environment, spec.commandEnvironmentVariable)
      : undefined);
  const command = configured ?? spec.command;

  if (pathFlavor.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return [{ candidate: command, source: "configured" }];
  }

  const candidates: HarnessCandidate[] = [];
  const extensions = executableExtensions(command, platform, input.environment);
  for (const directory of pathDirectories(input.environment, platform)) {
    for (const extension of extensions) {
      candidates.push({
        candidate: pathFlavor.join(directory, command + extension),
        source: "path",
      });
    }
  }

  // A configured command names one specific installation; do not silently fall
  // back to a different one somewhere else on the machine.
  if (configured !== undefined) return candidates;

  const home = resolveHomeDirectory(input);
  for (const directory of installRootDirectories(spec, input, dependencies, platform, home)) {
    for (const extension of installRootExtensions(platform)) {
      candidates.push({
        candidate: pathFlavor.join(directory, spec.command + extension),
        source: "install-root",
      });
    }
  }
  return candidates;
}

export function resolveHarnessExecutable(
  spec: HarnessDiscoverySpec,
  input: HarnessDiscoveryInput,
  dependencies: HarnessDiscoveryDependencies = {},
): HarnessResolution | undefined {
  const platform = input.platform ?? process.platform;
  const isExecutable =
    dependencies.isExecutable ?? ((candidate: string) => isExecutableFile(candidate, platform));
  const runnable = spec.runnableCandidate ?? ((candidate: string) => candidate);
  const context: RunnableCandidateContext = { platform, isExecutable };
  for (const { candidate, source } of harnessCandidates(spec, input, dependencies)) {
    const executable = runnable(candidate, context);
    if (executable !== undefined && isExecutable(executable)) return { executable, source };
  }
  return undefined;
}
