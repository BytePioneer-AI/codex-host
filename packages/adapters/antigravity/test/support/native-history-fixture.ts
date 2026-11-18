import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nativeConversationDbPath } from "../../src/fork.js";
import { bytes } from "./native-timing-fixture.js";

export async function createNativeHistoryDatabase(home: string, sessionId: string) {
  const file = nativeConversationDbPath(sessionId, home);
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB);
  `);
  return db;
}

export function textField(tag: number, text: string): Buffer {
  return bytes(tag, Buffer.from(text));
}

export function userStep(db: DatabaseSync, idx: number, text: string): void {
  db.prepare("INSERT INTO steps VALUES (?, 14, 3, ?)").run(
    idx,
    bytes(19, bytes(3, textField(1, text))),
  );
}

export function answerStep(db: DatabaseSync, idx: number, text: string): void {
  db.prepare("INSERT INTO steps VALUES (?, 15, 3, ?)").run(idx, bytes(20, textField(1, text)));
}
