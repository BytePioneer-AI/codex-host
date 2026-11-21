import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";
import { ChAttachments } from "../src/ch-attachments.ts";
import { ChThreadView } from "../src/ch-thread-view.ts";
import { ChThreadHistory } from "../src/ch-thread-history.ts";
import { WebImages, WEB_IMAGE_LIMITS } from "../src/web-images.ts";
import { DataDir } from "../src/store.ts";
import { FakeChHost } from "./support/ch-host.ts";
import { nativeImageInput, PNG } from "./support/image.ts";

function view(attachments: ChAttachments, input: unknown[], id = "thread") {
  const host = new FakeChHost();
  const row = host.add(id, "/workspace");
  const original = row.turns[0]?.items[0];
  assert.ok(original);
  original.content = input;
  const rendered = new ChThreadView(
    { ...row, turns: [] },
    "fake",
    () => {},
    0,
    0,
    () => false,
    (parts) => attachments.project(id, parts),
  );
  rendered.update(structuredClone(row));
  const event = rendered.log.events.find((event) => event.type === "user/message");
  assert.ok(event);
  const message = event.data as {
    content: Array<{
      type: string;
      text?: string;
      attachment?: { attachmentId: string; bytes: number; name: string };
    }>;
  };
  const ref = message.content.find((part) => part.type === "image")?.attachment;
  assert.ok(ref);
  return { rendered, ref, message };
}

function assistantImageRefs(rendered: ChThreadView) {
  return rendered.log.events.flatMap((event) => {
    if (event.type !== "assistant/message") return [];
    const content = (event.data as { message?: { content?: unknown[] } }).message?.content ?? [];
    return content.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const image = part as {
        type?: string;
        attachment?: { attachmentId: string; bytes: number; width: number; height: number };
      };
      return image.type === "image" && image.attachment ? [image.attachment] : [];
    });
  });
}

it("renders and authorizes native clipboard/file paths without copying bytes or execution context", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-native-images-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "codex-clipboard-56c36986-6e9d-425b-9918-c06b13abdc72.png");
  writeFileSync(path, Buffer.from(PNG, "base64"));
  const images = new WebImages(new DataDir(join(root, "web")));
  const attachments = new ChAttachments(images);
  const content = nativeImageInput(path, "Can you see it?", "clipboard screenshot.png");
  const before = JSON.stringify(content);
  const { rendered, ref, message } = view(attachments, content);
  assert.equal(ref.name, "clipboard screenshot.png");
  assert.match(ref.attachmentId, /^ch-image:[a-f0-9]{64}$/u);
  assert.equal(message.content.find((part) => part.type === "text")?.text, "Can you see it?");
  assert.equal(attachments.read(rendered, ref.attachmentId).data, PNG);
  assert.equal(JSON.stringify(content), before, "presentation must not rewrite native history");
  assert.deepEqual(
    readdirSync(images.directory),
    [],
    "native bytes stay in their original location",
  );
  assert.deepEqual(readFileSync(path), Buffer.from(PNG, "base64"));
  const other = view(attachments, content, "other");
  assert.notEqual(other.ref.attachmentId, ref.attachmentId);
  assert.throws(() => attachments.read(other.rendered, ref.attachmentId), /unavailable/u);
  assert.throws(() => attachments.read(rendered, "ch-image:" + "0".repeat(64)), /unavailable/u);
  assert.throws(() => attachments.read(rendered, path), /unavailable/u);
  // A projected event is not sufficient if the current authoritative window no longer references it.
  const original = rendered.thread.turns[0]?.items[0];
  assert.ok(original);
  original.content = [{ type: "text", text: "Not an attachment" }];
  assert.throws(() => attachments.read(rendered, ref.attachmentId), /unavailable/u);
});

it("loads grouped native imageView attachments from the authoritative Thread", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-image-views-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "first.png");
  writeFileSync(path, Buffer.from(PNG, "base64"));
  const attachments = new ChAttachments(new WebImages(new DataDir(join(root, "web"))));
  const host = new FakeChHost();
  const row = host.add("image-views", "/workspace");
  const turn = row.turns[0];
  assert.ok(turn);
  turn.items = [
    { id: "u", type: "userMessage", content: [{ type: "text", text: "look" }] },
    { id: "image-1", type: "imageView", path },
  ];
  const rendered = new ChThreadView(
    { ...row, turns: [] },
    "fake",
    () => {},
    0,
    0,
    () => false,
    (parts) => attachments.project("image-views", parts),
    (image, itemKey) => attachments.projectImageView("image-views", image, itemKey),
  );
  rendered.update(structuredClone(row));
  const message = rendered.log.events.find((event) => event.type === "assistant/message");
  assert.ok(message);
  const content = (message.data as { message: { content: unknown[] } }).message.content;
  const ref = (
    content.find((part) => (part as { type?: string }).type === "image") as {
      attachment: { attachmentId: string };
    }
  ).attachment;
  assert.equal(attachments.read(rendered, ref.attachmentId).data, PNG);
});

it("projects imageViews from older pages with the configured attachment callback", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-image-view-page-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "older.png");
  writeFileSync(path, Buffer.from(PNG, "base64"));
  const attachments = new ChAttachments(new WebImages(new DataDir(join(root, "web"))));
  const host = new FakeChHost();
  const row = host.add("older-image-views", root);
  row.turns = Array.from({ length: 7 }, (_, index) => ({
    id: `turn-${index}`,
    status: "completed",
    items:
      index === 0
        ? [
            { id: "old-user", type: "userMessage", content: [{ type: "text", text: "look" }] },
            { id: "old-image", type: "imageView", path },
          ]
        : [
            {
              id: `user-${index}`,
              type: "userMessage",
              content: [{ type: "text", text: `Question ${index}` }],
            },
          ],
  }));
  const history = new ChThreadHistory(
    host,
    row,
    "fake",
    () => {},
    undefined,
    (parts) => attachments.project(row.id, parts),
    (image, itemKey) => attachments.projectImageView(row.id, image, itemKey),
  );
  await history.refresh();
  assert.equal(history.thread.turns.length, 5);
  await history.loadOlder();
  const ref = assistantImageRefs(history)[0];
  assert.ok(ref);
  assert.equal(attachments.read(history, ref.attachmentId).data, PNG);
});

it("keeps a completed imageView fingerprint when only the backing file changes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-image-view-fingerprint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "captured.png");
  writeFileSync(path, Buffer.from(PNG, "base64"));
  const attachments = new ChAttachments(new WebImages(new DataDir(join(root, "web"))));
  const host = new FakeChHost();
  const row = host.add("image-view-fingerprint", root);
  row.turns = [
    {
      id: "turn",
      status: "completed",
      items: [
        { id: "user", type: "userMessage", content: [{ type: "text", text: "look" }] },
        { id: "image", type: "imageView", path },
      ],
    },
  ];
  const rendered = new ChThreadView(
    { ...row, turns: [] },
    "fake",
    () => {},
    0,
    0,
    () => false,
    (parts) => attachments.project(row.id, parts),
    (image, itemKey) => attachments.projectImageView(row.id, image, itemKey),
  );
  rendered.update(structuredClone(row));
  const projected = assistantImageRefs(rendered);
  assert.equal(projected.length, 1);
  assert.equal(attachments.read(rendered, projected[0]?.attachmentId ?? "").data, PNG);

  const changed = Buffer.from(PNG, "base64");
  changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
  writeFileSync(path, changed);
  assert.doesNotThrow(() => rendered.update(structuredClone(row)));
  assert.deepEqual(assistantImageRefs(rendered), projected);
  assert.throws(() => attachments.read(rendered, projected[0]?.attachmentId ?? ""), /unavailable/u);
  const replacement = join(root, "replacement.png");
  writeFileSync(replacement, Buffer.from(PNG, "base64"));
  const imageView = row.turns[0]?.items.find((item) => item.id === "image");
  assert.ok(imageView);
  imageView.path = replacement;
  assert.throws(() => rendered.update(structuredClone(row)), {
    code: "host/items-replaced",
  });
});

it("keeps an unavailable imageView placeholder unreadable after the file appears", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-image-view-unavailable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "late.png");
  const attachments = new ChAttachments(new WebImages(new DataDir(join(root, "web"))));
  const host = new FakeChHost();
  const row = host.add("image-view-unavailable", root);
  row.turns = [
    {
      id: "turn",
      status: "completed",
      items: [
        { id: "user", type: "userMessage", content: [{ type: "text", text: "look" }] },
        { id: "image", type: "imageView", path },
      ],
    },
  ];
  const rendered = new ChThreadView(
    { ...row, turns: [] },
    "fake",
    () => {},
    0,
    0,
    () => false,
    (parts) => attachments.project(row.id, parts),
    (image, itemKey) => attachments.projectImageView(row.id, image, itemKey),
  );
  rendered.update(structuredClone(row));
  const projected = assistantImageRefs(rendered)[0];
  assert.ok(projected);
  assert.equal(projected.bytes, 0);

  writeFileSync(path, Buffer.from(PNG, "base64"));
  assert.throws(() => attachments.read(rendered, projected.attachmentId), /unavailable/u);
});

it("normalizes imageView file URLs and surrounding whitespace for projection and reads", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-image-view-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "normalized.png");
  writeFileSync(path, Buffer.from(PNG, "base64"));
  const attachments = new ChAttachments(new WebImages(new DataDir(join(root, "web"))));
  const host = new FakeChHost();
  const row = host.add("image-view-path", root);
  row.turns = [
    {
      id: "turn",
      status: "completed",
      items: [
        { id: "user", type: "userMessage", content: [{ type: "text", text: "look" }] },
        {
          id: "image",
          type: "imageView",
          path: `  ${pathToFileURL(path).href.replace(/^file:\/\//u, "file:")}  `,
        },
      ],
    },
  ];
  const rendered = new ChThreadView(
    { ...row, turns: [] },
    "fake",
    () => {},
    0,
    0,
    () => false,
    (parts) => attachments.project(row.id, parts),
    (image, itemKey) => attachments.projectImageView(row.id, image, itemKey),
  );
  rendered.update(structuredClone(row));
  const ref = assistantImageRefs(rendered)[0];
  assert.ok(ref);
  assert.equal(attachments.read(rendered, ref.attachmentId).data, PNG);
});

it("preserves trailing spaces in bare native imageView paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-image-view-trailing-space-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "image.png ");
  const trimmed = join(root, "image.png");
  writeFileSync(path, Buffer.from(PNG, "base64"));
  const other = Buffer.from(PNG, "base64");
  other[other.length - 2] = (other[other.length - 2] ?? 0) ^ 1;
  writeFileSync(trimmed, other);
  const attachments = new ChAttachments(new WebImages(new DataDir(join(root, "web"))));
  const host = new FakeChHost();
  const row = host.add("image-view-trailing-space", root);
  row.turns = [
    {
      id: "turn",
      status: "completed",
      items: [
        { id: "user", type: "userMessage", content: [{ type: "text", text: "look" }] },
        { id: "image", type: "imageView", path },
      ],
    },
  ];
  const rendered = new ChThreadView(
    { ...row, turns: [] },
    "fake",
    () => {},
    0,
    0,
    () => false,
    (parts) => attachments.project(row.id, parts),
    (image, itemKey) => attachments.projectImageView(row.id, image, itemKey),
  );
  rendered.update(structuredClone(row));
  const ref = assistantImageRefs(rendered)[0];
  assert.ok(ref);
  assert.equal(attachments.read(rendered, ref.attachmentId).data, PNG);
});

it("gives repeated imageViews of one path independent attachment identities", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-image-view-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "reused.png");
  writeFileSync(path, Buffer.from(PNG, "base64"));
  const attachments = new ChAttachments(new WebImages(new DataDir(join(root, "web"))));
  const host = new FakeChHost();
  const row = host.add("image-view-identity", root);
  row.turns = [
    {
      id: "turn-1",
      status: "completed",
      items: [
        { id: "user-1", type: "userMessage", content: [{ type: "text", text: "first" }] },
        { id: "image-1", type: "imageView", path },
      ],
    },
  ];
  const rendered = new ChThreadView(
    { ...row, turns: [] },
    "fake",
    () => {},
    0,
    0,
    () => false,
    (parts) => attachments.project(row.id, parts),
    (image, itemKey) => attachments.projectImageView(row.id, image, itemKey),
  );
  rendered.update(structuredClone(row));
  const first = assistantImageRefs(rendered)[0];
  assert.ok(first);
  assert.equal(attachments.read(rendered, first.attachmentId).data, PNG);

  const changed = Buffer.from(PNG, "base64");
  changed[changed.length - 2] = (changed[changed.length - 2] ?? 0) ^ 1;
  writeFileSync(path, changed);
  row.turns.push({
    id: "turn-2",
    status: "completed",
    items: [
      { id: "user-2", type: "userMessage", content: [{ type: "text", text: "second" }] },
      { id: "image-2", type: "imageView", path },
    ],
  });
  rendered.update(structuredClone(row));

  const refs = assistantImageRefs(rendered);
  assert.equal(refs.length, 2);
  assert.notEqual(refs[0]?.attachmentId, refs[1]?.attachmentId);
  assert.throws(() => attachments.read(rendered, refs[0]?.attachmentId ?? ""), /unavailable/u);
  assert.equal(
    attachments.read(rendered, refs[1]?.attachmentId ?? "").data,
    changed.toString("base64"),
  );
});

it("handles structured localImage/file URLs and inline images; never fetches external URLs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-image-sources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "original.png");
  writeFileSync(path, Buffer.from(PNG, "base64"));
  const attachments = new ChAttachments(new WebImages(new DataDir(join(root, "web"))));
  for (const image of [
    { type: "localImage", path },
    { type: "image", url: pathToFileURL(path).href },
    { type: "image", url: `data:image/png;base64,${PNG}` },
  ]) {
    const { rendered, ref } = view(attachments, [image, { type: "text", text: "Question" }]);
    assert.equal(attachments.read(rendered, ref.attachmentId).data, PNG);
  }
  for (const image of [
    { type: "image", url: "http://127.0.0.1:1/private.png" },
    { type: "image", url: "file://remote/share/private.png" },
    { type: "image", url: `file://${root}/%2e%2e/original.png` },
    { type: "localImage", path: `${root}/child/../original.png` },
    { type: "image", url: "blob:private" },
    { type: "image", url: `data:image/jpeg;base64,${PNG}` },
    { type: "image", url: "data:image/svg+xml;base64,PHN2Zz4=" },
  ]) {
    const { rendered, ref } = view(attachments, [image]);
    assert.equal(ref.bytes, 0);
    assert.throws(() => attachments.read(rendered, ref.attachmentId), /unavailable/u);
  }
});

it("keeps missing, changed, invalid and symlink images as placeholders with readable user requests", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-image-unavailable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "image.png");
  const attachments = new ChAttachments(new WebImages(new DataDir(join(root, "web"))));
  const content = nativeImageInput(path, "Keep my request");
  const missing = view(attachments, content);
  assert.equal(missing.ref.bytes, 0);
  assert.equal(missing.message.content.at(-1)?.text, "Keep my request");
  assert.throws(() => attachments.read(missing.rendered, missing.ref.attachmentId), /unavailable/u);
  writeFileSync(path, Buffer.from(PNG, "base64"));
  assert.equal(
    attachments.read(missing.rendered, missing.ref.attachmentId).data,
    PNG,
    "explicit retry can recover a missing file",
  );
  const admitted = view(attachments, content);
  const changed = Buffer.from(PNG, "base64");
  changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
  writeFileSync(path, changed);
  assert.throws(
    () => attachments.read(admitted.rendered, admitted.ref.attachmentId),
    /unavailable/u,
  );
  writeFileSync(path, "not an image");
  const invalid = view(attachments, content);
  assert.equal(invalid.ref.bytes, 0);
  assert.throws(() => attachments.read(invalid.rendered, invalid.ref.attachmentId), /unavailable/u);
  if (process.platform === "win32") return;
  const target = join(root, "target.png");
  writeFileSync(target, Buffer.from(PNG, "base64"));
  rmSync(path);
  symlinkSync(target, path);
  const linked = view(attachments, content);
  assert.equal(linked.ref.bytes, 0);
  assert.throws(() => attachments.read(linked.rendered, linked.ref.attachmentId), /unavailable/u);
  const directory = join(root, "directory");
  mkdirSync(directory);
  writeFileSync(join(directory, "image.png"), Buffer.from(PNG, "base64"));
  symlinkSync(directory, join(root, "linked-directory"));
  const parent = view(attachments, nativeImageInput(join(root, "linked-directory", "image.png")));
  assert.throws(() => attachments.read(parent.rendered, parent.ref.attachmentId), /unavailable/u);
});

it("bounds native image reads and separates ordinary files without reading them", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-image-limits-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const attachments = new ChAttachments(new WebImages(new DataDir(join(root, "web"))));
  const path = join(root, "too-big.png");
  writeFileSync(path, Buffer.alloc(WEB_IMAGE_LIMITS.maxImageBytes + 1));
  const tooBig = view(attachments, nativeImageInput(path));
  assert.throws(() => attachments.read(tooBig.rendered, tooBig.ref.attachmentId), {
    code: "session/attachment-invalid",
    details: { reason: "IMAGE_TOO_LARGE" },
  });
  const dimension = Buffer.from(PNG, "base64");
  dimension.writeUInt32BE(8193, 16);
  writeFileSync(path, dimension);
  const tooWide = view(attachments, nativeImageInput(path));
  assert.equal(
    attachments.read(tooWide.rendered, tooWide.ref.attachmentId).data,
    dimension.toString("base64"),
  );
  dimension.writeUInt32BE(8192, 16);
  dimension.writeUInt32BE(8192, 20);
  writeFileSync(path, dimension);
  const tooManyPixels = view(attachments, nativeImageInput(path));
  assert.throws(() => attachments.read(tooManyPixels.rendered, tooManyPixels.ref.attachmentId), {
    code: "session/attachment-invalid",
    details: { reason: "IMAGE_TOO_MANY_PIXELS" },
  });
  const padded = Buffer.alloc(26 * 1024 * 1024);
  Buffer.from(PNG, "base64").copy(padded);
  const large = ["first.png", "second.png"].map((name) => {
    const path = join(root, name);
    writeFileSync(path, padded);
    return { type: "localImage", path };
  });
  const total = view(attachments, large);
  const overBudget = total.message.content.at(-1)?.attachment;
  assert.ok(overBudget);
  assert.equal(total.ref.bytes, padded.length);
  assert.equal(
    attachments.read(total.rendered, overBudget.attachmentId).data,
    padded.toString("base64"),
  );
  const many = Array.from({ length: 21 }, (_, index) => ({
    type: "localImage",
    path: join(root, `image-${index}.png`),
  }));
  for (const image of many) writeFileSync(image.path, Buffer.from(PNG, "base64"));
  const input = view(attachments, many);
  const last = input.message.content.at(-1)?.attachment;
  assert.ok(last);
  assert.equal(attachments.read(input.rendered, last.attachmentId).data, PNG);
  const original = nativeImageInput(join(root, "does-not-exist.png"), "Review")[0];
  assert.ok(original);
  const text = original.text.replace("Image attachment: true\n", "");
  const files = attachments.project("thread", [{ type: "text", text }]) as Array<{
    type: string;
    attachment?: { nativePath: string; name: string };
  }>;
  assert.equal(files[0]?.type, "file");
  assert.equal(files[0]?.attachment?.nativePath, join(root, "does-not-exist.png"));
  assert.deepEqual(readdirSync(join(root, "web", "attachments", "images")), []);
});

it("rebuilds native references after restart and only grants older-page images after loading them", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-native-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "codex-clipboard-old.png");
  writeFileSync(path, Buffer.from(PNG, "base64"));
  const data = new DataDir(join(root, "web"));
  const original = new ChAttachments(new WebImages(data));
  const content = nativeImageInput(path, "Older image question");
  const old = view(original, content);
  const restored = new ChAttachments(new WebImages(data));
  const host = new FakeChHost();
  const row = host.add("thread", root);
  row.turns = Array.from({ length: 7 }, (_, index) => ({
    id: `turn-${index}`,
    status: "completed",
    items: [
      {
        id: `message-${index}`,
        type: "userMessage",
        content: index === 0 ? content : [{ type: "text", text: `Question ${index}` }],
      },
    ],
  }));
  const history = new ChThreadHistory(
    host,
    row,
    "fake",
    () => {},
    undefined,
    (parts) => restored.project(row.id, parts),
  );
  await history.refresh();
  assert.throws(() => restored.read(history, old.ref.attachmentId), /unavailable/u);
  await history.loadOlder();
  assert.equal(restored.read(history, old.ref.attachmentId).data, PNG);
  assert.deepEqual(
    readdirSync(join(root, "web")),
    ["attachments"],
    "no native-image mapping/index is persisted",
  );
});
