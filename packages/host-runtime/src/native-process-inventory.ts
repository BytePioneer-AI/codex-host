import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";

const MAX_EXECUTABLE_NAME_BYTES = 256;
const MAX_PROCESS_IDS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const HELPER_TIMEOUT_MS = 3000;
const responseSchema = z
  .object({
    pids: z.array(z.number().int().positive().max(0xffff_ffff)).max(MAX_PROCESS_IDS),
  })
  .strict();

function validExecutableName(name: string): boolean {
  return (
    name.length > 0 &&
    Buffer.byteLength(name, "utf8") <= MAX_EXECUTABLE_NAME_BYTES &&
    name !== "." &&
    name !== ".." &&
    name.trim() === name &&
    !/[\\/\p{Cc}]/u.test(name)
  );
}

function readOne(
  launcher: string,
  executableName: string,
  environment: NodeJS.ProcessEnv | undefined,
): Promise<readonly number[]> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("Native process inventory unavailable"));
    try {
      execFile(
        launcher,
        ["process-inventory", "--name", executableName],
        {
          env: environment,
          windowsHide: true,
          timeout: HELPER_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: "utf8",
        },
        (error, stdout) => {
          if (error) return fail();
          try {
            resolve(responseSchema.parse(JSON.parse(stdout)).pids);
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

/**
 * Returns a point-in-time inventory of observable matching processes. An empty
 * result does not prove that another matching process cannot start later.
 */
export async function readNativeProcessIds(input: {
  launcher: string;
  executableNames: readonly string[];
  environment?: NodeJS.ProcessEnv;
}): Promise<number[]> {
  if (
    !path.isAbsolute(input.launcher) ||
    input.executableNames.length === 0 ||
    input.executableNames.some((name) => !validExecutableName(name))
  ) {
    throw new Error("Native process inventory unavailable");
  }
  const seenNames = new Set<string>();
  const names = input.executableNames.filter((name) => {
    const key = process.platform === "win32" ? name.toLocaleLowerCase("en-US") : name;
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });
  const processIds = new Set<number>();
  for (const name of names) {
    for (const processId of await readOne(input.launcher, name, input.environment)) {
      processIds.add(processId);
      if (processIds.size > MAX_PROCESS_IDS) {
        throw new Error("Native process inventory unavailable");
      }
    }
  }
  return [...processIds].sort((left, right) => left - right);
}
