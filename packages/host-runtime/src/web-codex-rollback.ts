import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  acquireSourceOwnerLock,
  canonicalSessionPath,
  rollbackSessionMigration,
} from "@codexhost/session-runtime";
import { readSharedHostExitProof } from "./shared-host-exit-proof.js";

/** Offline maintenance through the existing Host entry; never a browser operation. */
export async function runWebCodexRollback(
  arguments_: string[],
  runtimeEntrypoint: string,
): Promise<number> {
  try {
    const { values } = parseArgs({
      args: arguments_,
      options: { data: { type: "string" }, home: { type: "string" }, launcher: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    if (
      !values.data ||
      !values.home ||
      !values.launcher ||
      ![values.data, values.home, values.launcher].every(isAbsolute)
    )
      throw new Error(
        "rollback requires absolute --data <host-data> --home <original-home> --launcher <native-launcher>",
      );
    const data = canonicalSessionPath(values.data),
      home = canonicalSessionPath(values.home),
      launcher = values.launcher;
    // The native stop operation waits for the captured owner and supervised tree,
    // rather than treating an authenticated shutdown acknowledgement as exit proof.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        launcher,
        [
          "host",
          "stop",
          "--node",
          process.execPath,
          "--host-runtime",
          fileURLToPath(runtimeEntrypoint),
          "--data",
          data,
        ],
        { stdio: "inherit" },
      );
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`native-stop-unconfirmed: ${signal ?? code}`)),
      );
    });
    const nativeExitProof = await readSharedHostExitProof(
      { CODEXHOST_DATA_DIR: data },
      { maintenance: true },
    );
    const ownership = await acquireSourceOwnerLock({
      root: join(data, "web-codex"),
      home,
      ...(nativeExitProof ? { nativeExitProof } : {}),
    });
    try {
      rollbackSessionMigration(ownership, true);
    } finally {
      await ownership.release();
    }
    process.stderr.write(
      "Web Codex migration rolled back; the preserved legacy source can be used again.\n",
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `Web Codex rollback refused: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
