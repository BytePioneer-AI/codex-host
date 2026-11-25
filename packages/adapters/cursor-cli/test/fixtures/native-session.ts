import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Same minimal native store encoding as native-history.test.ts; no credentials or model calls.
function field(id: number, value: Buffer | string): Buffer {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const bytes: number[] = [];
  let length = data.length;
  do {
    bytes.push((length & 127) | (length > 127 ? 128 : 0));
    length = Math.floor(length / 128);
  } while (length);
  return Buffer.concat([Buffer.from([id * 8 + 2, ...bytes]), data]);
}

export function nativeSession(
  config: string,
  cwd: string,
  texts: string[] = ["hello"],
  sessionId = randomUUID(),
) {
  const directory = path.join(config, "acp-sessions", sessionId);
  mkdirSync(directory, { recursive: true });
  const metadata = path.join(directory, "meta.json");
  const database = path.join(directory, "store.db");
  writeFileSync(metadata, JSON.stringify({ cwd }));
  const turns = texts.map((text) => ({ id: randomUUID(), text }));
  const save = () => {
    const db = new DatabaseSync(database);
    try {
      db.exec(
        "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY,data BLOB)",
      );
      const put = (data: Buffer) => {
        const id = createHash("sha256").update(data).digest();
        db.prepare("INSERT OR IGNORE INTO blobs VALUES(?,?)").run(id.toString("hex"), data);
        return id;
      };
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
      db.prepare("INSERT OR REPLACE INTO meta VALUES('0',?)").run(
        Buffer.from(
          JSON.stringify({
            agentId: sessionId,
            latestRootBlobId: root.toString("hex"),
          }),
        ).toString("hex"),
      );
    } finally {
      db.close();
    }
  };
  save();
  return { sessionId, directory, metadata, database, turns, save };
}
