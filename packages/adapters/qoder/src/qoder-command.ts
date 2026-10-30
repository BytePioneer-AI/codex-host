import path from "node:path";
import {
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoveryDependencies,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

import type { QoderVariant } from "./qoder-runtime.js";

export class QoderExecutableError extends Error {
  readonly code = "QODER_NOT_FOUND";
}

export const CODEXHOST_QODER_COMMAND = "CODEXHOST_QODER_COMMAND";
export const CODEXHOST_QODERCN_COMMAND = "CODEXHOST_QODERCN_COMMAND";
export const QODER_SDK_CUSTOM_BASE_URL_BYOK = "QODER_SDK_CUSTOM_BASE_URL_BYOK";

export function qoderEnvironment(
  environment?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...environment,
    [QODER_SDK_CUSTOM_BASE_URL_BYOK]: environment?.[QODER_SDK_CUSTOM_BASE_URL_BYOK] ?? "1",
  };
}

function discoverySpec(variant: QoderVariant): HarnessDiscoverySpec {
  const cn = variant === "cn";
  const configDirectory = cn ? ".qoder-cn" : ".qoder";
  const productName = cn ? "QoderCN" : "Qoder";
  const command = cn ? "qoderclicn" : "qodercli";
  const npmPackage = cn ? "@qodercn-ai/qoderclicn" : "@qoder-ai/qodercli";
  return {
    id: cn ? "qoder-cn" : "qoder",
    command,
    commandEnvironmentVariable: cn ? CODEXHOST_QODERCN_COMMAND : CODEXHOST_QODER_COMMAND,
    installRoots: {
      posix: [
        "~/.local/bin",
        `~/${configDirectory}/bin`,
        VERSION_MANAGER_ROOTS,
        "/usr/local/bin",
        "/opt/homebrew/bin",
      ],
      windows: [
        `\${LOCALAPPDATA}/Programs/${productName}`,
        `\${LOCALAPPDATA}/${productName}`,
        `~/${configDirectory}/bin`,
        "${APPDATA}/npm",
        VERSION_MANAGER_ROOTS,
      ],
    },
    runnableCandidate: (candidate, { platform, isExecutable }) => {
      const pathFlavor = targetPath(platform);
      if (platform !== "win32" || pathFlavor.extname(candidate).toLowerCase() !== ".cmd") {
        return candidate;
      }
      const entrypoint = pathFlavor.join(
        pathFlavor.dirname(candidate),
        "node_modules",
        ...npmPackage.split("/"),
        "bundle",
        `${command}.js`,
      );
      return isExecutable(entrypoint) ? entrypoint : undefined;
    },
  };
}

export const qoderDiscoverySpec = discoverySpec("global");
export const qoderCnDiscoverySpec = discoverySpec("cn");

export function resolveQoderExecutable(
  input: {
    variant?: QoderVariant;
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
  dependencies: HarnessDiscoveryDependencies = {},
): string {
  const platform = input.platform ?? process.platform;
  const cn = input.variant === "cn";
  const spec = cn ? qoderCnDiscoverySpec : qoderDiscoverySpec;
  // Editor launchers (qoder/qodercn) are not SDK-compatible CLI runtimes.
  const resolution = resolveHarnessExecutable(
    spec,
    {
      ...(input.command ? { command: input.command } : {}),
      environment: input.environment ?? process.env,
      ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
      platform,
    },
    dependencies,
  );

  if (!resolution) throw new QoderExecutableError("Qoder CLI is not installed");
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}
