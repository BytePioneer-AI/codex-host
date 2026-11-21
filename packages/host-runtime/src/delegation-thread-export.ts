import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { JsonObject, RoutedHarnessId } from "@codexhost/protocol-core";

import { defaultDelegationWatchDirectory } from "./delegation-watch-store.js";
import { DelegationControlError } from "./delegation-types.js";

export interface ThreadExportInput {
  threadId: string;
  hostId?: string;
  /** Absolute for CLI callers; HTTP/MCP paths are on the receiving Host. */
  out?: string;
}

export interface ThreadExportResult {
  threadId: string;
  harnessId: RoutedHarnessId;
  path: string;
  bytes: number;
  turns: number;
  /** False while the Thread is running; does not certify native history completeness. */
  complete: boolean;
}

export interface FullDelegationThread {
  threadId: string;
  harnessId: RoutedHarnessId;
  thread: JsonObject;
  turns: readonly JsonObject[];
  running: boolean;
}

export function validateThreadExportInput(input: ThreadExportInput): void {
  if (
    typeof input.threadId !== "string" ||
    !input.threadId ||
    /[/\\\x00-\x1f<>:"|?*]/u.test(input.threadId) ||
    input.threadId === "." ||
    input.threadId === ".."
  )
    throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is invalid");
  if (input.hostId !== undefined && input.hostId !== "local")
    throw new DelegationControlError("INVALID_ARGUMENT", "Remote Hosts support thread read only");
  if (input.out !== undefined && (typeof input.out !== "string" || !input.out.trim()))
    throw new DelegationControlError("INVALID_ARGUMENT", "out must be a non-empty path");
}

export async function exportDelegationThread(
  input: ThreadExportInput,
  source: FullDelegationThread,
  environment: NodeJS.ProcessEnv,
): Promise<ThreadExportResult> {
  validateThreadExportInput(input);
  const exportedAt = new Date().toISOString();
  const directory = path.join(
    path.dirname(defaultDelegationWatchDirectory(environment)),
    "exports",
  );
  const target = input.out
    ? path.resolve(input.out)
    : path.join(directory, `${source.threadId}-${exportedAt.replaceAll(":", "-")}.json`);
  // Serialize before yielding so a live Turn cannot change during filesystem operations.
  const metadata = { ...source.thread };
  delete metadata.turns;
  const turnCount = source.turns.length;
  const data = `${JSON.stringify(
    {
      exportedAt,
      thread: { ...metadata, id: source.threadId, harnessId: source.harnessId },
      turns: source.turns,
    },
    null,
    2,
  )}\n`;
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.thread-export-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    threadId: source.threadId,
    harnessId: source.harnessId,
    path: target,
    bytes: Buffer.byteLength(data),
    turns: turnCount,
    complete: !source.running,
  };
}
