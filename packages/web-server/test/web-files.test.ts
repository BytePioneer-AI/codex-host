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
import { WebFiles } from "../src/web-files.ts";
import { ChFileInputs } from "../src/ch-file-inputs.ts";
import { ChAttachments } from "../src/ch-attachments.ts";
import { WebImages } from "../src/web-images.ts";
import { nativeImageInput, PNG } from "./support/image.ts";
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

it("cleans failed streams and rejects tampered or symlink stored objects", async (t) => {
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
  const { input: prepared } = await input.prepare("draft", content);
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
  const literal = nativeImageInput("/old/desktop.png", "Keep the whole literal example")[0]?.text;
  assert.ok(literal);
  const { input: withLiteral } = await input.prepare("draft", [
    { type: "file", receiptId: upload.receiptId },
    { type: "text", text: literal },
  ]);
  assert.equal(
    withLiteral[0]?.text.endsWith(literal),
    true,
    "presentation parsing must not strip execution text",
  );
  assert.equal((await files.resolve("draft", Array(21).fill(upload.receiptId))).length, 21);
});

it("stages explicit images in images/, preserves native text and presentation, and enforces combined quotas", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "web-image-receipts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root),
    images = new WebImages(data),
    files = new WebFiles(data, images);
  const input = new ChFileInputs(files, images, async (id) => id);
  const bytes = Buffer.from(PNG, "base64");
  const upload = await input.upload("draft", chunks(bytes), "photo.png", "image/png");
  const content = [
    { type: "file", receiptId: upload.receiptId },
    { type: "text", text: "Look" },
  ];
  const prepared = await input.prepare("draft", content);
  assert.deepEqual(
    prepared.input,
    images.prepare([{ type: "image", data: PNG, mediaType: "image/png" }, content[1]]),
  );
  assert.deepEqual(
    prepared.presentation,
    images.presentation([{ type: "image", data: PNG, mediaType: "image/png" }, content[1]]),
  );
  const saved = (await files.resolve("draft", [upload.receiptId]))[0];
  assert.ok(saved);
  assert.equal(saved.path.startsWith(images.directory), true);
  assert.deepEqual(images.read(upload.file.attachmentId).data, PNG);
  await assert.rejects(input.prepare("other", content), /not uploaded/u);
  await assert.rejects(
    input.upload("draft", chunks(Buffer.from("not an image")), "fake.png", "image/png"),
    /Only PNG/u,
  );
  let exhausted = false;
  await assert.rejects(
    input.upload(
      "draft",
      (async function* () {
        yield Buffer.alloc(20 * 1024 * 1024);
        yield Buffer.alloc(1);
        exhausted = true;
        yield Buffer.alloc(1);
      })(),
      "large.png",
      "image/png",
    ),
    /20 MiB/u,
  );
  assert.equal(exhausted, false);
  await assert.rejects(input.prepare("draft", Array(21).fill(content[0])), /20 images/u);
  const large = Buffer.concat([bytes, Buffer.alloc(17 * 1024 * 1024)]);
  const bigger = await input.upload("draft", chunks(large), "big.png", "image/png");
  await assert.rejects(
    input.prepare("draft", [
      { type: "file", receiptId: bigger.receiptId },
      { type: "image", data: large.toString("base64"), mediaType: "image/png" },
    ]),
    /32 MiB/u,
  );
  const mixed = await input.prepare("draft", [
    content[0],
    { type: "image", data: PNG, mediaType: "image/png" },
    content[0],
  ]);
  const firstInput = mixed.input[0];
  assert.ok(firstInput);
  assert.deepEqual(
    [...firstInput.text.matchAll(/## (image-\d+.png):/gu)].map((match) => match[1]),
    ["image-1.png", "image-2.png", "image-3.png"],
  );
});

it("streams above 64 MiB, admits totals above 128 MiB, and does not cap pending file count", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "web-files-unlimited-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = new WebFiles(new DataDir(root));
  const block = Buffer.alloc(1024 * 1024, 42);
  const large = await files.upload(
    "draft",
    (async function* () {
      for (let i = 0; i < 65; i++) yield block;
    })(),
    "large.bin",
  );
  assert.equal(large.file.bytes, 65 * 1024 * 1024);
  const twice = await files.resolve("draft", [large.receiptId, large.receiptId]);
  assert.equal(
    twice.reduce((sum, file) => sum + file.file.bytes, 0),
    130 * 1024 * 1024,
  );
  const ids: string[] = [];
  for (let i = 0; i < 1025; i++)
    ids.push((await files.upload("draft", chunks(Buffer.alloc(0)), "empty.txt")).receiptId);
  assert.equal((await files.resolve("draft", ids)).length, 1025);
});
