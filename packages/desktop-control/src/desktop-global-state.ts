import type { Stats } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_STATE_BYTES = 32 * 1024 * 1024;

function checkStateFile(info: Stats) {
  if (!info.isFile() || info.size > MAX_STATE_BYTES)
    throw new Error("Invalid or oversized Desktop global state file");
}

function ignoreMissingFile(error: NodeJS.ErrnoException): undefined {
  if (error.code === "ENOENT") return undefined;
  throw error;
}

/** After Desktop's migration the legacy JSON may still exist, but only SQLite is current. */
export async function readDesktopGlobalState(
  codexHome: string,
  legacyFile = join(codexHome, ".codex-global-state.json"),
): Promise<unknown> {
  const file = join(codexHome, ".codex-global-state.sqlite");
  const info = await lstat(file).catch(ignoreMissingFile);
  if (info) {
    checkStateFile(info.isSymbolicLink() ? await stat(file) : info);
    const state = await readSqliteState(file);
    if (state !== undefined) return state;
  }

  const handle = await open(legacyFile, "r").catch(ignoreMissingFile);
  if (!handle) return {};
  try {
    checkStateFile(await handle.stat());
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text) > MAX_STATE_BYTES)
      throw new Error("Desktop global state exceeds its read limit");
    return JSON.parse(text);
  } finally {
    await handle.close();
  }
}

async function readSqliteState(file: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  let rows;
  try {
    // Keep the version and rows in one snapshot, then release the read lock before parsing.
    db.exec("PRAGMA busy_timeout = 3000; BEGIN");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version === 0) return undefined;
    if (version !== 1) throw new Error(`Unsupported global state database version: ${version}`);
    rows = db.prepare("SELECT scope, key, value FROM settings").all();
  } finally {
    db.close();
  }

  const state = new Map<string, unknown>();
  const scopes = new Map<string, Map<string, unknown>>();
  for (const { scope, key, value } of rows) {
    if (typeof scope !== "string" || typeof key !== "string" || typeof value !== "string")
      throw new Error("Invalid Desktop global state row");
    const parsed: unknown = JSON.parse(value);
    if (scope === "global") {
      state.set(key, parsed);
    } else {
      const name = scope === "atom" ? "electron-persisted-atom-state" : scope;
      const entries = scopes.get(name) ?? new Map<string, unknown>();
      entries.set(key, parsed);
      scopes.set(name, entries);
    }
  }
  for (const [name, entries] of scopes) state.set(name, Object.fromEntries(entries));
  return Object.fromEntries(state);
}
