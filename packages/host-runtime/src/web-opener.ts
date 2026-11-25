import { spawn } from "node:child_process";
import path from "node:path";
import type { WebOpenResult } from "@codexhost/shared-contracts";
import { readRuntimeMetadata } from "@codexhost/update-manager";

export interface HostWebOpener {
  open(): Promise<WebOpenResult>;
}

/** The Launcher owns Web startup, service reuse and browser opening. */
export function createHostWebOpener(environment: NodeJS.ProcessEnv): HostWebOpener | undefined {
  const launcher = environment.CODEXHOST_LAUNCHER_EXECUTABLE;
  if (!launcher || !path.isAbsolute(launcher) || environment.CODEXHOST_REMOTE_SSH_MANAGED === "1") {
    return undefined;
  }
  return {
    async open() {
      const runtime = await readRuntimeMetadata(
        environment.CODEXHOST_HOST_RUNTIME_PATH ?? "",
        environment,
      ).catch(() => null);
      if (!runtime || runtime.distribution === "development") {
        throw new Error("Background Web is unavailable in a development build; run npm start web");
      }
      return new Promise((resolve, reject) => {
        const child = spawn(launcher, ["web", "--connect-devices"], {
          env: environment,
          // The login URL belongs to the Launcher, not the Renderer or Host logs.
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-16 * 1024);
        });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 0) resolve({});
          else {
            reject(new Error(stderr.trim().split(/\r?\n/u).at(-1) || "Web could not be opened"));
          }
        });
      });
    },
  };
}
