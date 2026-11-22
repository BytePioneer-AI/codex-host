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

export function runField(run: string): Buffer {
  return run ? bytes(5, textField(12, run)) : Buffer.alloc(0);
}

export function userStep(db: DatabaseSync, idx: number, text: string, run = ""): void {
  db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, 14, 3, ?)").run(
    idx,
    Buffer.concat([runField(run), bytes(19, bytes(3, textField(1, text)))]),
  );
}

export function answerStep(db: DatabaseSync, idx: number, text: string, run = ""): void {
  db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, 15, 3, ?)").run(
    idx,
    Buffer.concat([runField(run), bytes(20, textField(1, text))]),
  );
}

export function systemStep(db: DatabaseSync, idx: number, run: string, eventType?: string): void {
  db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, 101, 3, ?)").run(
    idx,
    Buffer.concat([runField(run), ...(eventType ? [bytes(114, textField(3, eventType))] : [])]),
  );
}

export function planModeSwitch(
  db: DatabaseSync,
  idx: number,
  from: string,
  to: string,
  direction: "exit" | "enter" = "exit",
): void {
  const call = Buffer.concat([textField(1, `plan-${idx}`), textField(2, `${direction}_plan_mode`)]);
  const insert = db.prepare("INSERT INTO steps VALUES (?, ?, 3, ?)");
  insert.run(idx, 15, Buffer.concat([runField(from), bytes(20, bytes(7, call))]));
  insert.run(
    idx + 1,
    132,
    Buffer.concat([
      bytes(5, Buffer.concat([textField(12, from), bytes(4, call)])),
      bytes(140, Buffer.alloc(0)),
    ]),
  );
  systemStep(db, idx + 2, to, direction === "exit" ? "plan_mode_handoff" : "plan_mode_handback");
}

export function checkpointStep(
  db: DatabaseSync,
  idx: number,
  options: { status?: number; run?: string; summary?: string; error?: string } = {},
): void {
  const { status = 3, run = "", summary, error } = options;
  db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, 23, ?, ?)").run(
    idx,
    status,
    Buffer.concat([
      runField(run),
      ...(summary === undefined ? [] : [bytes(30, textField(1, summary))]),
      ...(error === undefined ? [] : [bytes(31, textField(2, error))]),
    ]),
  );
}
