import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  remoteSshSetupResultSchema,
  type RemoteSshSetupParams,
  type RemoteSshSetupResult,
} from "@codexhost/shared-contracts";

/** Rust owns SSH execution and installation; this bridge exposes only fixed operations. */
export async function runRemoteSshSetup(
  runtimePath: string,
  environment: NodeJS.ProcessEnv,
  input: RemoteSshSetupParams,
): Promise<RemoteSshSetupResult> {
  const binary = process.platform === "win32" ? "codexhost-updater.exe" : "codexhost-updater";
  const directory = path.dirname(runtimePath);
  const source =
    path.basename(directory) === "dist" &&
    path.basename(path.dirname(directory)) === "host-runtime" &&
    path.basename(path.resolve(directory, "../..")) === "packages";
  const helper = source
    ? path.resolve(directory, "../../../target/debug", binary)
    : path.resolve(directory, "../libexec", binary);
  await access(helper).catch(() => {
    throw new Error("SSH installation helper is unavailable. Update local codexhost and restart.");
  });
  return new Promise((resolve, reject) => {
    const child = spawn(helper, ["ssh"], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let diagnostic = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output = (output + chunk).slice(0, 16_384);
    });
    child.stderr.on("data", (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(0, 4096);
    });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            diagnostic.trim() || "SSH installation failed; check the remote computer and retry",
          ),
        );
        return;
      }
      try {
        resolve(remoteSshSetupResultSchema.parse(JSON.parse(output)));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
