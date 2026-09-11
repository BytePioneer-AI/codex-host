import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { protobufBytes, readCursorNativeTurns } from "../src/native-history.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value = Math.floor(value / 128);
  } while (value);
  return Buffer.from(bytes);
}
function field(id: number, value: Buffer | string) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(id * 8 + 2), varint(data.length), data]);
}
function fixture(texts = ["first", "second"]) {
  const home = mkdtempSync(path.join(os.tmpdir(), "codexhost-cursor-history-"));
  temporary.push(home);
  const sessionId = randomUUID();
  const directory = path.join(home, ".cursor", "acp-sessions", sessionId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ cwd: home }));
  const db = new DatabaseSync(path.join(directory, "store.db"));
  db.exec(
    "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB)",
  );
  const put = (data: Buffer) => {
    const id = createHash("sha256").update(data).digest();
    db.prepare("INSERT OR IGNORE INTO blobs VALUES(?,?)").run(id.toString("hex"), data);
    return id;
  };
  const turns = texts.map((text) => ({ id: randomUUID(), text }));
  const root = put(
    Buffer.concat(
      turns.map((turn) =>
        field(
          8,
          put(field(1, field(1, put(Buffer.concat([field(1, turn.text), field(2, turn.id)]))))),
        ),
      ),
    ),
  );
  db.prepare("INSERT INTO meta VALUES('0',?)").run(
    Buffer.from(
      JSON.stringify({ agentId: sessionId, latestRootBlobId: root.toString("hex") }),
    ).toString("hex"),
  );
  db.close();
  return { home, sessionId, turns };
}
describe("Cursor read-only native identity", () => {
  it("returns stable ordered native IDs from a freshly opened store", () => {
    const f = fixture();
    expect(readCursorNativeTurns(f.sessionId, f.home, { HOME: f.home })).toEqual(f.turns);
    expect(readCursorNativeTurns(f.sessionId, f.home, { HOME: f.home })).toEqual(f.turns);
  });
  it("allows a new empty history without inventing IDs", () => {
    const f = fixture([]);
    expect(readCursorNativeTurns(f.sessionId, f.home, { HOME: f.home })).toEqual([]);
  });
  it("rejects workspace mismatch and path traversal", () => {
    const f = fixture();
    expect(() =>
      readCursorNativeTurns(f.sessionId, path.join(f.home, "other"), { HOME: f.home }),
    ).toThrow("workspace");
    expect(() => readCursorNativeTurns("../../outside", f.home, { HOME: f.home })).toThrow(
      "session ID",
    );
  });
  it("does not treat missing history as empty on resume", () => {
    const f = fixture();
    expect(() => readCursorNativeTurns(randomUUID(), f.home, { HOME: f.home })).toThrow();
    expect(readCursorNativeTurns(randomUUID(), f.home, { HOME: f.home }, true)).toEqual([]);
  });
  it.each([{ bytes: [0x80] }, { bytes: [0x0a, 20, 1] }, { bytes: [0x0b, 0] }, { bytes: [0] }])(
    "rejects malformed protobuf $bytes",
    ({ bytes }) => {
      expect(() => protobufBytes(Buffer.from(bytes))).toThrow();
    },
  );
});
