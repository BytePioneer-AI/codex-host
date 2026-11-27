import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeDesktopGlobalStateDatabase } from "../../../tests/fixtures/desktop-global-state.js";
import { readDesktopGlobalState } from "../src/desktop-global-state.js";

const MAX_STATE_BYTES = 32 * 1024 * 1024;

describe("Desktop global state read limits", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "desktop-global-state-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("reads current SQLite settings when free pages exceed the file size limit", async () => {
    writeDesktopGlobalStateDatabase(home, [
      ["global", "project-order", ["current"]],
      ["atom", "sidebar", { expanded: true }],
    ]);
    await writeFile(
      join(home, ".codex-global-state.json"),
      JSON.stringify({ "project-order": ["stale"] }),
    );
    const file = join(home, ".codex-global-state.sqlite");
    const database = new DatabaseSync(file);
    try {
      database.exec(`
        INSERT INTO settings (scope, key, value)
          VALUES ('global', 'deleted', json_quote(hex(zeroblob(17 * 1024 * 1024))));
        DELETE FROM settings WHERE key = 'deleted';
      `);
    } finally {
      database.close();
    }
    const before = await stat(file);
    expect(before.size).toBeGreaterThan(MAX_STATE_BYTES);

    await expect(readDesktopGlobalState(home)).resolves.toEqual({
      "project-order": ["current"],
      "electron-persisted-atom-state": { sidebar: { expanded: true } },
    });
    expect((await stat(file)).size).toBe(before.size);
  });

  it.each(["JSON", "SQLite"])("rejects oversized %s state payloads", async (source) => {
    const value = "界".repeat(6 * 1024 * 1024);
    if (source === "SQLite") {
      writeDesktopGlobalStateDatabase(home, [
        ["global", "first", value],
        ["atom", "second", value],
      ]);
    } else {
      await writeFile(
        join(home, ".codex-global-state.json"),
        JSON.stringify({ first: value, second: value }),
      );
    }

    await expect(readDesktopGlobalState(home)).rejects.toThrow(/global state/);
  });
});
