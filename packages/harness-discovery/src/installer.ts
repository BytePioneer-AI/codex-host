import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchInstallationText, runInstallationCommand } from "./installation.js";
import { resolveHarnessExecutable, VERSION_MANAGER_ROOTS } from "./resolve.js";
import { withNodeRuntimeOnPath } from "./node-runtime.js";

/** Trusted Adapter-owned sources only; never accept these options from an RPC caller. */
export type HarnessInstallerSource =
  | { npm: string; allowScripts?: string }
  | { posix: string; windows: string; shell?: "sh" | "bash" };

export function createHarnessInstaller(
  environment: NodeJS.ProcessEnv,
  source: HarnessInstallerSource,
): () => Promise<void> {
  return async () => {
    if (!["darwin", "linux", "win32"].includes(process.platform))
      throw new Error("Unsupported installation platform");
    const env = withNodeRuntimeOnPath(environment);
    if ("npm" in source) {
      const npm = resolveHarnessExecutable(
        {
          id: "npm",
          command: "npm",
          installRoots: {
            posix: [
              "~/.npm-global/bin",
              "~/.local/bin",
              VERSION_MANAGER_ROOTS,
              "/opt/homebrew/bin",
              "/usr/local/bin",
              "/usr/bin",
            ],
            windows: [
              "${APPDATA}/npm",
              VERSION_MANAGER_ROOTS,
              "${ProgramFiles}/nodejs",
              "${LOCALAPPDATA}/Programs/nodejs",
            ],
          },
        },
        { environment: env },
      );
      if (!npm) throw new Error("Install Node.js and npm first");
      await runInstallationCommand(
        npm.executable,
        ["install", "--global", source.npm],
        {
          ...env,
          ...(source.allowScripts ? { npm_config_allow_scripts: source.allowScripts } : {}),
        },
        600_000,
      );
      return;
    }
    const windows = process.platform === "win32";
    const url = windows ? source.windows : source.posix;
    if (new URL(url).protocol !== "https:") throw new Error("Installer requires HTTPS");
    const script = await fetchInstallationText(url);
    const directory = await mkdtemp(join(tmpdir(), "codexhost-installer-"));
    try {
      const file = join(directory, windows ? "install.ps1" : "install.sh");
      await writeFile(file, script, { mode: 0o600 });
      await runInstallationCommand(
        windows ? "powershell.exe" : (source.shell ?? "bash"),
        windows
          ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file]
          : [file],
        env,
        600_000,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
