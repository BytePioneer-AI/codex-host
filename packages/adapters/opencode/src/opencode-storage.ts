import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { OpenCodeMessage, OpenCodePart } from "./opencode-history.js";

export interface OpenCodeStorageOptions {
  environment?: NodeJS.ProcessEnv | undefined;
  homeDirectory?: string;
}

export interface OpenCodeStoredSession {
  sessionId: string;
  title: string;
  model?: unknown;
  agent?: unknown;
  directory: string;
  messages: OpenCodeMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parsePart(value: unknown): OpenCodePart | null {
  const record = parseJson(value);
  if (!record || typeof record.type !== "string") return null;
  return record as OpenCodePart;
}

function parseMessage(
  value: unknown,
  sessionId: string,
  id: string,
  parts: OpenCodePart[],
): OpenCodeMessage | null {
  const record = parseJson(value);
  if (!record || (record.role !== "user" && record.role !== "assistant")) return null;
  const message: OpenCodeMessage = {
    id,
    role: record.role,
    parts,
  };
  if (typeof record.parentID === "string") message.parentID = record.parentID;
  if (typeof record.finish === "string") message.finish = record.finish;
  if (record.model !== undefined) message.model = record.model;
  if (record.tokens !== undefined) message.tokens = record.tokens;
  if (record.cost !== undefined) message.cost = record.cost;
  return message;
}

export function openCodeDatabasePath(options: OpenCodeStorageOptions = {}): string {
  const environment = { ...process.env, ...(options.environment ?? {}) };
  const home = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  const dataHome = environment.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
}

export function readOpenCodeHistory(
  dbPath: string,
  sessionId: string,
): OpenCodeStoredSession | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const sessionRow = db
      .prepare("SELECT id, title, directory, metadata FROM session WHERE id = ?")
      .get(sessionId) as
      | {
          id: string;
          title: string;
          directory: string;
          metadata: string;
        }
      | undefined;
    if (!sessionRow) return null;
    const sessionData = parseJson(sessionRow.metadata);
    const messageRows = db
      .prepare(
        "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id",
      )
      .all(sessionId) as Array<{ id: string; data: string }>;
    const partRows = db
      .prepare(
        "SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id",
      )
      .all(sessionId) as Array<{ id: string; message_id: string; data: string }>;
    const partsByMessage = new Map<string, OpenCodePart[]>();
    for (const row of partRows) {
      const part = parsePart(row.data);
      if (!part) continue;
      const list = partsByMessage.get(row.message_id) ?? [];
      list.push(part);
      partsByMessage.set(row.message_id, list);
    }
    const messages: OpenCodeMessage[] = [];
    for (const row of messageRows) {
      const message = parseMessage(row.data, sessionId, row.id, partsByMessage.get(row.id) ?? []);
      if (message) messages.push(message);
    }
    return {
      sessionId: sessionRow.id,
      title: sessionRow.title,
      directory: sessionRow.directory,
      ...(sessionData?.model !== undefined ? { model: sessionData.model } : {}),
      ...(sessionData?.agent !== undefined ? { agent: sessionData.agent } : {}),
      messages,
    };
  } finally {
    db.close();
  }
}
