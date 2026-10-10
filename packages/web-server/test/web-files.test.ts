import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DataDir } from "../src/store.ts";
import { WebFiles, WEB_FILE_LIMITS } from "../src/web-files.ts";
import { ChFileInputs } from "../src/ch-file-inputs.ts";
import { ChAttachments } from "../src/ch-attachments.ts";
import { WebImages } from "../src/web-images.ts";
import { PNG } from "./support/image.ts";
async function* chunks(bytes: Uint8Array) {
  yield bytes.subarray(0, 2);
  yield bytes.subarray(2);
}

it("streams arbitrary bytes, preserves names/extensions safely and scopes receipts to Sessions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "web-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = new WebFiles(new DataDir(root));
  const bytes = Buffer.from([0, 255, 1, 42, 10]);
  for (const name of [
    "notes.txt",
    "report.pdf",
    "table.xlsx",
    "archive.zip",
    "binary.exe",
    "unknown.xyz",
    "../../inject\n## name: x",
    "CON.txt",
    "空文件.dat",
  ]) {
    const result = await files.upload("draft", chunks(bytes), name);
    const [stored] = await files.resolve("draft", [result.receiptId]);
    assert.ok(stored);
    assert.deepEqual(readFileSync(stored.path), bytes);
    assert.equal(result.file.bytes, bytes.length);
    assert.equal(result.file.name.includes("\n"), false);
    assert.equal(result.file.name.includes("/"), false);
    await assert.rejects(files.resolve("other", [result.receiptId]), /not uploaded/u);
    files.bind("draft", "canonical");
    assert.equal((await files.resolve("canonical", [result.receiptId]))[0]?.path, stored.path);
    files.consume("canonical", [result.receiptId]);
    await assert.rejects(files.resolve("canonical", [result.receiptId]), /not uploaded/u);
    assert.deepEqual(new WebFiles(new DataDir(root)).reference(stored.path), result.file);
  }
  const empty = await files.upload("draft", chunks(Buffer.alloc(0)), "empty.txt");
  assert.equal(empty.file.bytes, 0);
  assert.equal(readdirSync(root).includes("sessions"), false);
});

it("cleans failed/oversized streams and rejects tampered or symlink stored objects", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "web-files-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = new WebFiles(new DataDir(root));
  await assert.rejects(
    files.upload(
      "draft",
      (async function* () {
        yield Buffer.from("partial");
        throw new Error("cancelled");
      })(),
    ),
    /cancelled/u,
  );
  await assert.rejects(
    files.upload(
      "draft",
      (async function* () {
        for (let i = 0; i < 65; i++) yield Buffer.alloc(1024 * 1024);
      })(),
    ),
    /64 MiB/u,
  );
  assert.deepEqual(readdirSync(files.directory), []);
  const result = await files.upload("draft", chunks(Buffer.from("original")), "notes.txt");
  const [saved] = await files.resolve("draft", [result.receiptId]);
  assert.ok(saved);
  writeFileSync(saved.path, "modified");
  await assert.rejects(files.resolve("draft", [result.receiptId]), /unavailable/u);
  await assert.rejects(
    files.upload("draft", chunks(Buffer.from("original")), "notes.txt"),
    /unavailable/u,
  );
  assert.equal(files.reference("/outside/file.txt"), undefined);
  if (process.platform !== "win32") {
    rmSync(saved.path);
    const target = join(root, "foreign.txt");
    writeFileSync(target, "original");
    symlinkSync(target, saved.path);
    await assert.rejects(files.resolve("draft", [result.receiptId]), /unavailable/u);
    assert.equal(files.reference(saved.path), undefined);
    assert.equal(readFileSync(target, "utf8"), "original");
  }
});

it("combines files/images into native path context, checks receipts before image persistence, and restores file cards", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "web-file-prompts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root),
    files = new WebFiles(data),
    images = new WebImages(data);
  const input = new ChFileInputs(files, images, async (id) => id);
  const bytes = Buffer.from("a,b\n1,2\n");
  const upload = await input.upload("draft", chunks(bytes), "table.csv");
  const content = [
    { type: "file", receiptId: upload.receiptId },
    { type: "image", data: PNG, mediaType: "image/png" },
    { type: "text", text: "Review both" },
  ];
  await assert.rejects(input.prepare("other", content), /not uploaded/u);
  assert.deepEqual(readdirSync(images.directory), []);
  const prepared = await input.prepare("draft", content);
  assert.ok(prepared[0]?.text.includes("table.csv:"));
  assert.equal(prepared[0]?.text.includes(PNG), false);
  const projected = new ChAttachments(images, new WebFiles(data)).project(
    "canonical",
    prepared,
  ) as Array<{ type: string; text?: string; attachment?: { attachmentId: string; bytes: number } }>;
  assert.equal(projected[0]?.type, "file");
  assert.equal(projected[0]?.attachment?.attachmentId, upload.file.attachmentId);
  assert.equal(projected[0]?.attachment?.bytes, bytes.length);
  assert.equal(projected[1]?.type, "image");
  assert.equal(projected[2]?.text, "Review both");
  await assert.rejects(
    files.resolve("draft", Array(WEB_FILE_LIMITS.maxFilesPerMessage + 1).fill(upload.receiptId)),
    /20 files/u,
  );
});
