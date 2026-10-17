import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { canonicalSessionPath, type NativeExitProof } from "@codexhost/session-runtime";

/** Only a native-supervised owner reads the previous supervisor's bounded private proof. */
export async function readSharedHostExitProof(
  environment: NodeJS.ProcessEnv,
  options?: { maintenance: true },
): Promise<NativeExitProof | undefined> {
  if (
    (!environment.CODEXHOST_SHARED_HOST_GENERATION && !options?.maintenance) ||
    !environment.CODEXHOST_DATA_DIR
  )
    return undefined;
  let handle;
  try {
    handle = await open(
      path.join(environment.CODEXHOST_DATA_DIR, "shared-host-exit-v1.json"),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      (process.platform !== "win32" &&
        (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
    )
      throw new Error("native-exit-proof-invalid");
    const proof = JSON.parse(await handle.readFile("utf8")) as Partial<NativeExitProof> & {
      version?: number;
      dataRoot?: string;
    };
    if (
      proof.version !== 1 ||
      typeof proof.pid !== "number" ||
      !Number.isInteger(proof.pid) ||
      (proof.pid ?? 0) <= 0 ||
      typeof proof.generation !== "string" ||
      !/^\d+-\d+$/u.test(proof.generation) ||
      proof.dataRoot !== canonicalSessionPath(environment.CODEXHOST_DATA_DIR)
    )
      throw new Error("native-exit-proof-invalid");
    return {
      pid: proof.pid,
      generation: proof.generation,
      ownerRoot: canonicalSessionPath(path.join(environment.CODEXHOST_DATA_DIR, "web-codex")),
    };
  } finally {
    await handle.close();
  }
}
