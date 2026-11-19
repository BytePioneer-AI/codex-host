import path from "node:path";
import { readFileSync } from "node:fs";
import {
  resolveHarnessExecutable,
  isExecutableFile,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoveryDependencies,
  type HarnessDiscoveryInput,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export const copilotDiscoverySpec: HarnessDiscoverySpec = {
  id: "copilot",
  command: "copilot",
  commandEnvironmentVariable: "CODEXHOST_COPILOT_COMMAND",
  installRoots: {
    posix: ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", VERSION_MANAGER_ROOTS],
    windows: ["${APPDATA}/npm", "${LOCALAPPDATA}/Microsoft/WinGet/Links", VERSION_MANAGER_ROOTS],
  },
};

export class CopilotLaunchError extends Error {
  constructor(
    readonly code: "notInstalled" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}

export function resolveCopilotExecutable(
  input: HarnessDiscoveryInput,
  dependencies: HarnessDiscoveryDependencies & { readTextFile?: (file: string) => string } = {},
): string {
  const resolution = resolveHarnessExecutable(copilotDiscoverySpec, input, dependencies);
  if (!resolution) {
    throw new CopilotLaunchError(
      "notInstalled",
      "Copilot CLI was not found. Install the official CLI or set CODEXHOST_COPILOT_COMMAND.",
    );
  }
  const platform = input.platform ?? process.platform;
  const executable = resolution.executable;
  // Resolve only this npm launcher's package bin. Never execute or interpret a shell shim.
  if (platform === "win32" && /\.(cmd|bat)$/iu.test(executable)) {
    const paths = targetPath(platform);
    const root = paths.join(paths.dirname(executable), "node_modules", "@github", "copilot");
    const read = dependencies.readTextFile ?? ((file: string) => readFileSync(file, "utf8"));
    try {
      const metadata = JSON.parse(read(paths.join(root, "package.json"))) as {
        name?: string;
        bin?: string | Record<string, string>;
      };
      const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.copilot;
      if (
        metadata.name === "@github/copilot" &&
        typeof bin === "string" &&
        !paths.parse(bin).root &&
        !bin.split(/[\\/]/u).includes("..") &&
        (bin.endsWith(".js") || /\.exe$/iu.test(bin))
      ) {
        const target = paths.resolve(root, bin);
        const relative =
          `node_modules/@github/copilot/${bin.replaceAll("\\", "/").replace(/^\.\//u, "")}`.toLowerCase();
        const shim = read(executable).replaceAll("\\", "/").toLowerCase();
        if (shim.includes(`"%dp0%/${relative}" %*`) || shim.includes(`"%~dp0/${relative}" %*`)) {
          const exists =
            dependencies.isExecutable ?? ((file: string) => isExecutableFile(file, platform));
          if (exists(target)) return target;
        }
      }
    } catch {
      /* Not a complete matching npm installation. */
    }
    throw new CopilotLaunchError(
      "unsupported",
      "Copilot command shim has no matching npm JavaScript/executable entrypoint. Repair this installation or set CODEXHOST_COPILOT_COMMAND to its actual entrypoint.",
    );
  }
  return targetPath(platform).isAbsolute(executable) ? executable : path.resolve(executable);
}
