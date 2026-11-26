import { createReadStream } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { JsonObject } from "@codexhost/shared-contracts";
import type { PiSessionHistory } from "./pi-history.js";

const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface PiSessionHeader {
  type: "session";
  id: string;
  cwd: string;
  version?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readPiSessionHeader(sessionFile: string): Promise<PiSessionHeader> {
  const handle = await open(sessionFile, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_SESSION_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const contents = buffer.subarray(0, bytesRead);
    const newline = contents.indexOf(0x0a);
    if (newline < 0 && bytesRead === buffer.length) {
      throw new Error("Pi Session header exceeds the supported size");
    }
    const headerText = utf8Decoder.decode(newline < 0 ? contents : contents.subarray(0, newline));
    let parsed: unknown;
    try {
      parsed = JSON.parse(headerText);
    } catch {
      throw new Error("Pi Session header is not valid JSON");
    }
    if (
      !isRecord(parsed) ||
      parsed.type !== "session" ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0 ||
      typeof parsed.cwd !== "string" ||
      parsed.cwd.length === 0
    ) {
      throw new Error("Pi Session header is invalid");
    }
    return {
      type: "session",
      id: parsed.id,
      cwd: parsed.cwd,
      ...(typeof parsed.version === "number" ? { version: parsed.version } : {}),
    };
  } finally {
    await handle.close();
  }
}

export async function verifyPiSessionCwd(input: {
  sessionFile: string | null;
  sessionId: string;
  expectedCwd: string;
}): Promise<void> {
  if (!input.sessionFile) throw new Error("Pi Fork Session has no persisted Session file");
  const header = await readPiSessionHeader(input.sessionFile);
  if (header.id !== input.sessionId) {
    throw new Error("Pi Fork Session header identity does not match RPC state");
  }
  const [actualCwd, expectedCwd] = await Promise.all([
    realpath(header.cwd),
    realpath(input.expectedCwd),
  ]);
  if (actualCwd !== expectedCwd) {
    throw new Error("Pi Fork Session did not bind the requested cwd");
  }
}

function historyEntry(value: unknown): JsonObject | null {
  if (
    !isRecord(value) ||
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

async function* sessionLines(sessionFile: string): AsyncGenerator<string> {
  const input = createReadStream(sessionFile, { encoding: "utf8" });
  let pending = "";
  try {
    for await (const chunk of input) {
      const contents = chunk as string;
      let start = 0;
      let newline: number;
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

export async function readPiSessionHistory(sessionFile: string): Promise<PiSessionHistory> {
  const entries: JsonObject[] = [];
  let leafId: string | null = null;
  for await (const line of sessionLines(sessionFile)) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = historyEntry(parsed);
    if (!entry) continue;
    entries.push(entry);
    leafId = entry.id as string;
  }
  return { entries, leafId };
}
