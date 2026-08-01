import { open, realpath } from "node:fs/promises";

const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface PiSessionHeader {
  type: "session";
  id: string;
  cwd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPiSessionHeader(sessionFile: string): Promise<PiSessionHeader> {
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
    return { type: "session", id: parsed.id, cwd: parsed.cwd };
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
