import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DataDir } from "../src/store.ts";
import { WebFiles } from "../src/web-files.ts";

it("uses native canonical paths for storage, verification and history references", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "web-file-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Windows can give the same directory different drive-letter/8.3 spellings.
  // Supply a different drive case explicitly instead of assuming TEMP's casing.
  const alias =
    process.platform === "win32"
      ? root.replace(/^[A-Za-z]/u, (drive) => drive.toLowerCase())
      : root;
  const files = new WebFiles(new DataDir(alias));
  assert.equal(files.directory, realpathSync.native(join(root, "attachments", "files")));
  const bytes = Buffer.from("canonical storage fixture");
  const staged = await files.upload(
    "draft",
    (async function* () {
      yield bytes;
    })(),
    "Native Name.txt",
  );
  const [stored] = await files.resolve("draft", [staged.receiptId]);
  assert.ok(stored);
  assert.equal(stored.path, realpathSync.native(stored.path));
  assert.deepEqual(readFileSync(stored.path), bytes);
  assert.deepEqual(new WebFiles(new DataDir(root)).reference(stored.path), staged.file);
});
