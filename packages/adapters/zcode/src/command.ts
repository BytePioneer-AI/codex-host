import { accessSync, constants, statSync } from "node:fs";
import {
  commandInvocation,
  environmentValue,
  isExecutableFile,
  isDirectory,
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoveryDependencies,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";
import { ZcodeError } from "./errors.js";
import { zcodeProviderEnvironment } from "./provider-environment.js";

function isReadableFile(file: string): boolean {
  try {
    accessSync(file, constants.R_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

const cliSpec: HarnessDiscoverySpec = {
  id: "zcode",
  command: "zcode",
  commandEnvironmentVariable: "CODEXHOST_ZCODE_COMMAND",
  installRoots: {
    posix: [
      "~/.local/bin",
      "~/.npm-global/bin",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
    windows: ["${APPDATA}/npm", "~/.local/bin", VERSION_MANAGER_ROOTS],
  },
};
const desktopSpec: HarnessDiscoverySpec = {
  id: "zcode",
  command: "zcode.cjs",
  runnableCandidate: (candidate) => candidate.replace(/(\.cjs)\.(?:exe|cmd)$/iu, "$1"),
  installRoots: {
    posix: [
      "/Applications/ZCode.app/Contents/Resources/glm",
      "/Applications/Zcode.app/Contents/Resources/glm",
      "~/Applications/ZCode.app/Contents/Resources/glm",
      "/opt/ZCode/resources/glm",
      "/opt/zcode/resources/glm",
      "/usr/lib/zcode/resources/glm",
    ],
    windows: [
      "${LOCALAPPDATA}/Programs/ZCode/resources/glm",
      "${ProgramFiles}/ZCode/resources/glm",
    ],
  },
};
export function zcodeInvocation(
  environment: NodeJS.ProcessEnv,
  command?: string,
  platform: NodeJS.Platform = process.platform,
  dependencies: HarnessDiscoveryDependencies & {
    isReadableFile?: (file: string) => boolean;
    isDirectory?: (file: string) => boolean;
  } = {},
) {
  const input = { environment, platform, ...(command ? { command } : {}) };
  const readable = dependencies.isReadableFile ?? isReadableFile;
  const executable = dependencies.isExecutable ?? ((file) => isExecutableFile(file, platform));
  const configured = command ?? environmentValue(environment, "CODEXHOST_ZCODE_COMMAND");
  const paths = targetPath(platform);
  const cli = {
    ...cliSpec,
    runnableCandidate: (candidate: string) => {
      if (candidate === configured && (dependencies.isDirectory ?? isDirectory)(candidate)) {
        return platform === "darwin"
          ? paths.join(candidate, "Contents", "Resources", "glm", "zcode.cjs")
          : paths.join(candidate, "resources", "glm", "zcode.cjs");
      }
      // A Windows Desktop executable on PATH is not the app-server CLI. Use
      // only its own bundled script, executed by the Host's Node runtime.
      if (platform === "win32" && paths.extname(candidate).toLowerCase() === ".exe") {
        const script = paths.join(paths.dirname(candidate), "resources", "glm", "zcode.cjs");
        if (executable(candidate) && readable(script)) return script;
      }
      return candidate;
    },
  };
  const resolution =
    resolveHarnessExecutable(cli, input, {
      ...dependencies,
      isExecutable: (file) => (/\.[cm]?js$/iu.test(file) ? readable(file) : executable(file)),
    }) ??
    (configured !== undefined
      ? undefined
      : resolveHarnessExecutable(desktopSpec, input, { ...dependencies, isExecutable: readable }));
  if (!resolution)
    throw new ZcodeError(
      "notInstalled",
      "Install ZCode or set CODEXHOST_ZCODE_COMMAND to its installation directory or native entrypoint",
    );
  const args = ["app-server", "--stdio", "--surface", "terminal"];
  if (/\.[cm]?js$/iu.test(resolution.executable)) {
    const childEnvironment = zcodeProviderEnvironment(
      resolution.executable,
      environment,
      platform,
      readable,
    );
    return {
      ...commandInvocation(
        process.execPath,
        [resolution.executable, ...args],
        childEnvironment,
        platform,
      ),
      environment: childEnvironment,
    };
  }
  return { ...commandInvocation(resolution.executable, args, environment, platform), environment };
}
