import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { harnessThinkingOptionIdSchema, jsonValueSchema } from "@codexhost/shared-contracts";
import type { PiNativeModelRef } from "./pi-model-catalog.js";
import { randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import path from "node:path";

import { activePiEntries, mapPiSnapshot, type PiSessionHistory } from "./pi-history.js";
import type { PiSessionState } from "./pi-rpc-session.js";
import { readPiSessionHeader, verifyPiSessionCwd } from "./pi-session-file.js";

/** Publish a stopped, independently forked empty Session in Pi's native v3 format. */
export async function persistEmptyPiSession(input: {
  state: PiSessionState;
  history: PiSessionHistory;
  sourceSessionFile: string;
  sourceSessionId: string;
  cwd: string;
}): Promise<void> {
  const { state, history, sourceSessionFile, sourceSessionId, cwd } = input;
  const destination = state.sessionFile;
  if (
    !destination ||
    !path.isAbsolute(destination) ||
    path.resolve(destination) === path.resolve(sourceSessionFile) ||
    state.sessionId === sourceSessionId ||
    mapPiSnapshot(history, { sessionId: state.sessionId, model: null }).turns.length !== 0
  )
    throw new Error("Pi empty Session is not an independent empty native fork");
  await verifyPiSessionCwd({
    sessionFile: sourceSessionFile,
    sessionId: sourceSessionId,
    expectedCwd: cwd,
  });
  // The format is explicit: never reinterpret a future native Session version as v3.
  const sourceHeader = await readPiSessionHeader(sourceSessionFile);
  if (sourceHeader.type !== "session" || sourceHeader.version !== 3) {
    throw new Error("Pi empty Session persistence requires native v3 history");
  }
  const entries = history.entries;
  const active = activePiEntries(history);
  if (
    active.length !== entries.length ||
    active.some((entry, index) => entry.id !== entries[index]?.id)
  ) {
    throw new Error("Pi empty Session must expose its complete active branch");
  }
  const header = {
    type: "session",
    version: 3,
    id: state.sessionId,
    timestamp: new Date().toISOString(),
    cwd,
    parentSession: sourceSessionFile,
  };
  const temporary = path.join(path.dirname(destination), `.codexhost-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(
        [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      await file.sync();
    } finally {
      await file.close();
    }
    // A native writer or another owner wins rather than being overwritten.
    await link(temporary, destination);
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(destination), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface PiEmptySessionConfiguration {
  model: PiNativeModelRef;
  thinkingLevel: string;
}

/** Empty native v3 Sessions otherwise restart with global defaults in Pi. */
export async function readPiEmptySessionConfiguration(
  sessionFile: string,
): Promise<PiEmptySessionConfiguration | undefined> {
  let header;
  try {
    header = await readPiSessionHeader(sessionFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (header.version !== 3) return undefined;
  const stream = createReadStream(sessionFile, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let readFailure: Error | undefined;
  stream.on("error", (error) => {
    readFailure = error;
    lines.close();
  });
  let model: PiNativeModelRef | undefined;
  let thinkingLevel: string | undefined;
  let previous: string | null = null;
  let first = true;
  try {
    for await (const line of lines) {
      if (first) {
        first = false;
        continue;
      }
      if (!line.trim()) continue;
      const entry = jsonValueSchema.parse(JSON.parse(line));
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
      // Only a linear, message-free history is eligible. Native branching and nonempty
      // Sessions retain Pi's own restore behavior.
      if (entry.type === "message" || typeof entry.id !== "string" || entry.parentId !== previous)
        return undefined;
      previous = entry.id;
      if (
        entry.type === "model_change" &&
        typeof entry.provider === "string" &&
        typeof entry.modelId === "string"
      ) {
        model = { provider: entry.provider, id: entry.modelId };
      }
      if (entry.type === "thinking_level_change") {
        thinkingLevel = harnessThinkingOptionIdSchema.parse(entry.thinkingLevel);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (readFailure) throw readFailure;
  return model && thinkingLevel ? { model, thinkingLevel } : undefined;
}
