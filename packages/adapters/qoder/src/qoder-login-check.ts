import { execFile } from "node:child_process";

/** A failed SDK transport is ambiguous; only the CLI's explicit login diagnostic is evidence. */
export function qoderLoginRequired(text: string): boolean {
  return /\bnot logged in\b|\bauthentication (?:required|expired)\b/i.test(text);
}

export function checkQoderLogin(
  executable: string,
  environment: NodeJS.ProcessEnv | undefined,
  cwd: string | undefined,
): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ["--list-models"],
      {
        env: environment,
        cwd,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve(Boolean(error && !error.killed && qoderLoginRequired(`${stdout}\n${stderr}`)));
      },
    );
  });
}
