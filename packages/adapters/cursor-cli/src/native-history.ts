import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CursorNativeTurn {
  id: string;
  text: string;
}

/** Minimal, bounded wire decoder for the observed 2026.09.08 native store.
 * This is NOT an official Cursor API. Unknown/missing identity fails closed.
 * Never decode or expose provider messages, encryption keys, or signatures. */
export function protobufBytes(data: Uint8Array): Map<number, Buffer[]> {
  if (data.length > 32 * 1024 * 1024) throw new Error("Cursor native record is too large");
  let offset = 0;
  const varint = () => {
    let result = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      const value = data[offset++];
      if (value === undefined) throw new Error("Truncated Cursor native record");
      result += (value & 127) * 2 ** shift;
      if (!(value & 128)) return result;
    }
    throw new Error("Invalid Cursor native varint");
  };
  const fields = new Map<number, Buffer[]>();
  while (offset < data.length) {
    const tag = varint();
    const field = Math.floor(tag / 8),
      wire = tag % 8;
    if (!Number.isSafeInteger(tag) || field === 0) throw new Error("Invalid Cursor native field");
    if (wire === 0) {
      varint();
      continue;
    }
    const length = wire === 2 ? varint() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > data.length)
      throw new Error("Unsupported Cursor native record");
    if (wire === 2) {
      const values = fields.get(field) ?? [];
      values.push(Buffer.from(data.subarray(offset, offset + length)));
      fields.set(field, values);
    }
    offset += length;
  }
  return fields;
}

function one(fields: Map<number, Buffer[]>, field: number): Buffer {
  const values = fields.get(field);
  if (values?.length !== 1 || !values[0])
    throw new Error("Cursor native history identity is missing or ambiguous");
  return values[0];
}

export function readCursorNativeTurns(
  sessionId: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  allowMissing = false,
): CursorNativeTurn[] {
  if (!/^[0-9a-f-]{36}$/iu.test(sessionId)) throw new Error("Unsupported Cursor native session ID");
  const home = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  const directory = path.join(home, ".cursor", "acp-sessions", sessionId);
  const filename = path.join(directory, "store.db");
  if (allowMissing && !existsSync(filename)) return [];
  const info: unknown = JSON.parse(readFileSync(path.join(directory, "meta.json"), "utf8"));
  if (
    !info ||
    typeof info !== "object" ||
    !("cwd" in info) ||
    typeof info.cwd !== "string" ||
    path.resolve(info.cwd) !== path.resolve(cwd)
  )
    throw new Error("Cursor session workspace does not match");
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec("BEGIN");
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("0");
    if (!row && allowMissing) return [];
    if (typeof row?.value !== "string" || row.value.length > 1_000_000)
      throw new Error("Unsupported Cursor native metadata");
    const metadata = JSON.parse(Buffer.from(row.value, "hex").toString("utf8")) as {
      agentId?: unknown;
      latestRootBlobId?: unknown;
    };
    if (metadata.agentId !== sessionId || typeof metadata.latestRootBlobId !== "string")
      throw new Error("Cursor native session identity mismatch");
    const get = (id: string) => {
      if (!/^[0-9a-f]{64}$/u.test(id)) throw new Error("Invalid Cursor native blob reference");
      const blob = db.prepare("SELECT data FROM blobs WHERE id = ?").get(id)?.data;
      if (!(blob instanceof Uint8Array)) throw new Error("Cursor native history blob is missing");
      return protobufBytes(blob);
    };
    const root = get(metadata.latestRootBlobId);
    const result: CursorNativeTurn[] = [];
    for (const ref of root.get(8) ?? []) {
      if (ref.length !== 32) throw new Error("Unsupported Cursor turn reference");
      const container = get(ref.toString("hex"));
      for (const record of container.get(1) ?? []) {
        const turn = protobufBytes(record);
        const user = get(one(turn, 1).toString("hex"));
        const id = one(user, 2).toString("utf8");
        if (!/^[0-9a-f-]{36}$/iu.test(id) || result.some((existing) => existing.id === id))
          throw new Error("Cursor native turn ID is invalid or duplicated");
        result.push({ id, text: one(user, 1).toString("utf8") });
      }
    }
    return result;
  } finally {
    db.close();
  }
}
