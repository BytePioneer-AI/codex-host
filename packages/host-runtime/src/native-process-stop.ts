import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";

const responseSchema = z.object({ stopped: z.number().int().min(0).max(256) }).strict();

/** Native helper snapshots and stops one batch; it does not chase respawned processes. */
export async function stopNativeProcesses(input: {
  launcher: string;
  executableNames: readonly string[];
  environment?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (
    !path.isAbsolute(input.launcher) ||
    input.executableNames.length === 0 ||
    input.executableNames.length > 8 ||
    input.executableNames.some(
      (name) =>
        !name ||
        name === "." ||
        name === ".." ||
        name.trim() !== name ||
        Buffer.byteLength(name) > 256 ||
        /[\\/\p{Cc}]/u.test(name),
    )
  )
    throw new Error("Native process stop could not be confirmed");
  await new Promise<void>((resolve, reject) => {
    const fail = () => reject(new Error("Native process stop could not be confirmed"));
    try {
      execFile(
        input.launcher,
        [
          "process-stop",
          ...[...new Set(input.executableNames)].flatMap((name) => ["--name", name]),
        ],
        {
          env: input.environment,
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 4096,
          encoding: "utf8",
        },
        (error, stdout) => {
          if (error) return fail();
          try {
            responseSchema.parse(JSON.parse(stdout));
            resolve();
          } catch {
            fail();
          }
        },
      );
    } catch {
      fail();
    }
  });
}
