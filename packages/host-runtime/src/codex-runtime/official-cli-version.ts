import { execFile } from "node:child_process";

/** --version exits before native config/auth initialization; no app-server is started. */
export function readOfficialCliVersion(
  stockCodexPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      stockCodexPath,
      ["--version"],
      { env: environment, windowsHide: true, timeout: 5000, maxBuffer: 4096, encoding: "utf8" },
      (error, stdout) => {
        const match = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/u.exec(
          stdout.trim(),
        );
        if (error || !match?.[1]) reject(new Error("Unsupported official CLI version"));
        else resolve(match[1]);
      },
    );
  });
}
