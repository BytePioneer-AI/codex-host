import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function writeDesktopGlobalStateDatabase(
  home: string,
  rows: [scope: string, key: string, value: unknown][],
  version = 1,
) {
  const db = new DatabaseSync(join(home, ".codex-global-state.sqlite"));
  try {
    db.exec(`CREATE TABLE settings (
      scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    ) WITHOUT ROWID`);
    const insert = db.prepare("INSERT INTO settings (scope, key, value) VALUES (?, ?, ?)");
    for (const [scope, key, value] of rows) insert.run(scope, key, JSON.stringify(value));
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}
