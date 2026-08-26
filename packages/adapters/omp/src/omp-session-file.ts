import { open, realpath } from "node:fs/promises";

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
