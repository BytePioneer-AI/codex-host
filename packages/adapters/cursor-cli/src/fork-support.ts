import { existsSync } from "node:fs";
import { nativeCheckpointRefSchema } from "@codexhost/shared-contracts";

/** The native interactive command needs a PTY. Windows has no supported runner here. */
export function cursorForkAvailable(): boolean {
  return (
    (process.platform === "darwin" || process.platform === "linux") && existsSync("/usr/bin/script")
  );
}

export function cursorCheckpoint(sessionId: string, turnId: string) {
  return nativeCheckpointRefSchema.parse({
    harnessId: "cursor-cli",
    nativeSessionId: sessionId,
    checkpointId: turnId,
    locator: { kind: "cursor-turn" },
    formatVersion: 1,
  });
}
