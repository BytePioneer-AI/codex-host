import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";

const responseSchema = z.object({ identity: z.string().min(1).max(256).nullable() }).strict();

/** Uses platform process birth identity, not PID existence or logical socket closure. */
export function readNativeProcessIdentity(launcher: string, pid: number): Promise<string | null> {
  if (!path.isAbsolute(launcher) || !Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647)
    return Promise.reject(new Error("Native process identity unavailable"));
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("Native process identity unavailable"));
    const child = execFile(
      launcher,
      ["process-identity"],
      { windowsHide: true, timeout: 5000, maxBuffer: 4096, encoding: "utf8" },
      (error, stdout) => {
        if (error) return fail();
        try {
          resolve(responseSchema.parse(JSON.parse(stdout)).identity);
        } catch {
          fail();
        }
      },
    );
    child.stdin?.on("error", fail);
    child.stdin?.end(JSON.stringify(pid));
  });
}
