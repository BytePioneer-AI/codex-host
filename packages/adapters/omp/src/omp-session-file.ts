import { createReadStream } from "node:fs";
import { open, realpath } from "node:fs/promises";

import type { JsonObject } from "@codexhost/shared-contracts";

import type { OmpSessionHistory } from "./omp-history.js";

const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface OmpSessionHeader {
  type: "session";
  id: string;
  cwd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function historyEntry(value: unknown): JsonObject | null {
  if (
    !isRecord(value) ||
    value.type === "title" ||
    value.type === "session" ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    (value.parentId !== null && typeof value.parentId !== "string") ||
    typeof value.type !== "string"
  ) {
    return null;
  }
  return value as JsonObject;
}

async function* sessionLines(sessionFile: string, maxBytes?: number): AsyncGenerator<string> {
  const input = createReadStream(sessionFile, {
    encoding: "utf8",
    ...(maxBytes === undefined ? {} : { end: maxBytes - 1 }),
  });
  let pending = "";
  try {
    for await (const chunk of input) {
      const contents = chunk as string;
      let start = 0;
      let newline: number;
      // JSONL is LF-delimited. Node 26 readline also splits on U+2028/U+2029,
      // which are valid unescaped characters inside JSON strings.
      while ((newline = contents.indexOf("\n", start)) !== -1) {
        const line = pending + contents.slice(start, newline);
        pending = "";
        yield line.endsWith("\r") ? line.slice(0, -1) : line;
        start = newline + 1;
      }
      pending += contents.slice(start);
    }
    if (pending.length > 0) yield pending.endsWith("\r") ? pending.slice(0, -1) : pending;
  } finally {
    input.destroy();
  }
}

export async function readOmpSessionHistory(
  sessionFile: string,
  maxBytes?: number,
): Promise<OmpSessionHistory> {
  const entries: JsonObject[] = [];
  let leafId: string | null = null;
  let incomplete = false;
  for await (const line of sessionLines(sessionFile, maxBytes)) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      incomplete = true;
      continue;
    }
    const entry = historyEntry(parsed);
    if (!entry) {
      if (!isRecord(parsed) || (parsed.type !== "title" && parsed.type !== "session")) {
        incomplete = true;
      }
      continue;
    }
    entries.push(entry);
    leafId = entry.id as string;
  }
  return { entries, leafId, ...(incomplete ? { incomplete: true } : {}) };
}

async function readOmpSessionHeader(sessionFile: string): Promise<OmpSessionHeader> {
  const handle = await open(sessionFile, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_SESSION_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const contents = buffer.subarray(0, bytesRead);
    const newline = contents.indexOf(0x0a);
    if (newline < 0 && bytesRead === buffer.length) {
      throw new Error("Omp Session header exceeds the supported size");
    }
    const contentsText = utf8Decoder.decode(contents);
    for (const line of contentsText.split("\n")) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed) || parsed.type !== "session") continue;
      if (
        typeof parsed.id !== "string" ||
        parsed.id.length === 0 ||
        typeof parsed.cwd !== "string" ||
        parsed.cwd.length === 0
      ) {
        throw new Error("Omp Session header is invalid");
      }
      return { type: "session", id: parsed.id, cwd: parsed.cwd };
    }
    throw new Error("Omp Session header is invalid");
  } finally {
    await handle.close();
  }
}

export async function verifyOmpSessionCwd(input: {
  sessionFile: string | null;
  sessionId: string;
  expectedCwd: string;
}): Promise<void> {
  if (!input.sessionFile) throw new Error("Omp Fork Session has no persisted Session file");
  const header = await readOmpSessionHeader(input.sessionFile);
  if (header.id !== input.sessionId) {
    throw new Error("Omp Fork Session header identity does not match RPC state");
  }
  const [actualCwd, expectedCwd] = await Promise.all([
    realpath(header.cwd),
    realpath(input.expectedCwd),
  ]);
  if (actualCwd !== expectedCwd) {
    throw new Error("Omp Fork Session did not bind the requested cwd");
  }
}
