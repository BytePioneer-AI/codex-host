import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claudeUserContent } from "../src/turn-input.js";

function png(width: number, height: number): Buffer {
  const data = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "latin1");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

/** SOI, an APP0 segment, then SOF0 carrying the size. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([
    0xff,
    0xe0,
    0,
    0x10,
    ...Buffer.from("JFIF\0"),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ]);
  const sof = Buffer.from([
    0xff, 0xc0, 0, 0x11, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function webp(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Buffer {
  const data = Buffer.alloc(32);
  data.write("RIFF", 0, "latin1");
  data.writeUInt32LE(24, 4);
  data.write("WEBP", 8, "latin1");
  data.write(chunk, 12, "latin1");
  if (chunk === "VP8 ") {
    data.writeUInt16LE(width, 26);
    data.writeUInt16LE(height, 28);
  } else if (chunk === "VP8L") {
    data[20] = 0x2f;
    data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
  } else {
    data.writeUIntLE(width - 1, 24, 3);
    data.writeUIntLE(height - 1, 27, 3);
  }
  return data;
}

function gif(width: number, height: number): Buffer {
  const data = Buffer.alloc(32);
  data.write("GIF89a", 0, "latin1");
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return data;
}

const PNG = png(1, 1);
const JPEG = jpeg(1, 1);
const WEBP = webp("VP8 ", 1, 1);

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function files(entries: Record<string, Buffer>): Promise<Record<string, string>> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-turn-input-"));
  directories.push(directory);
  const paths: Record<string, string> = {};
  for (const [name, data] of Object.entries(entries)) {
    paths[name] = path.join(directory, name);
    await writeFile(paths[name], data);
  }
  return paths;
}

function desktopPrompt(images: string[], request: string): string {
  const context = images
    .map((file) => `## ${path.basename(file)}: ${file}\nImage attachment: true\n`)
    .join("\n");
  return `# Files mentioned by the user:\n\n${context}\n## My request:\n${request}`;
}

function image(mediaType: string, data: Buffer) {
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: data.toString("base64") },
  };
}

describe("Claude Code user content", () => {
  it("keeps a prompt without Desktop image attachments as text", async () => {
    const { "shot.png": shot = "" } = await files({ "shot.png": PNG });
    const text = `Compare with ${shot}\nImage attachment: true`;
    await expect(claudeUserContent(text)).resolves.toBe(text);
  });

  it("follows the unchanged prompt with each distinct attached image", async () => {
    const paths = await files({ "a.png": PNG, "b.jpg": JPEG, "c.webp": WEBP });
    const a = paths["a.png"] ?? "";
    const b = paths["b.jpg"] ?? "";
    const c = paths["c.webp"] ?? "";
    const text = desktopPrompt([a, b, a, c], "What changed?");
    await expect(claudeUserContent(text)).resolves.toEqual([
      { type: "text", text },
      image("image/png", PNG),
      image("image/jpeg", JPEG),
      image("image/webp", WEBP),
    ]);
  });

  it("leaves files it cannot read as path text only", async () => {
    const { "a.png": present = "", "locked.png": locked = "" } = await files({
      "a.png": PNG,
      "locked.png": PNG,
    });
    const directory = path.dirname(present);
    const missing = path.join(directory, "gone.png");
    const folder = path.join(directory, "folder.png");
    await mkdir(folder);
    await chmod(locked, 0);
    const text = desktopPrompt([missing, folder, locked, present], "Look");
    // Permission bits do not stop root or Windows from reading the file.
    const lockedReadable = process.platform === "win32" || process.getuid?.() === 0;
    const expected = lockedReadable ? [image("image/png", PNG)] : [];
    await expect(claudeUserContent(text)).resolves.toEqual([
      { type: "text", text },
      ...expected,
      image("image/png", PNG),
    ]);
    const unreadable = desktopPrompt([missing], "Look");
    await expect(claudeUserContent(unreadable)).resolves.toBe(unreadable);
  });

  it("leaves files over 20 MiB as path text only", async () => {
    const large = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)]);
    const { "large.png": file = "" } = await files({ "large.png": large });
    const text = desktopPrompt([file], "Look");
    await expect(claudeUserContent(text)).resolves.toBe(text);
  });

  it("steers only images within 5 MB of base64 and 2000 px per side", async () => {
    const fitting = {
      "a.png": png(2000, 2000),
      "b.jpg": jpeg(1200, 2000),
      "c.gif": gif(640, 480),
      "d.webp": webp("VP8 ", 100, 50),
      "e.webp": webp("VP8L", 2000, 1),
      "f.webp": webp("VP8X", 1, 2000),
    };
    const oversized = {
      "g.png": png(2001, 10),
      "h.jpg": jpeg(10, 4000),
      "i.gif": gif(2001, 1),
      "j.webp": webp("VP8X", 3000, 3000),
      "k.png": Buffer.concat([png(10, 10), Buffer.alloc(4 * 1024 * 1024)]),
      "l.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
    };
    const paths = await files({ ...fitting, ...oversized });
    const all = Object.keys(paths).map((name) => paths[name] ?? "");
    const text = desktopPrompt(all, "Look");
    const mediaTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };
    const blocks = Object.entries(fitting).map(([name, data]) =>
      image(mediaTypes[name.split(".")[1] ?? ""] ?? "", data),
    );
    await expect(claudeUserContent(text, { steer: true })).resolves.toEqual([
      { type: "text", text },
      ...blocks,
    ]);
    // A Turn Claude starts is shrunk natively, so the same images all become blocks.
    const started = await claudeUserContent(text);
    expect(Array.isArray(started) ? started.length : 0).toBe(all.length + 1);
  });

  it("leaves formats the Messages API cannot take as path text only", async () => {
    const paths = await files({ "a.heic": Buffer.from("ftypheic"), "b.png": PNG });
    const heic = paths["a.heic"] ?? "";
    const only = desktopPrompt([heic], "Look");
    await expect(claudeUserContent(only)).resolves.toBe(only);
    const mixed = desktopPrompt([heic, paths["b.png"] ?? ""], "Look");
    await expect(claudeUserContent(mixed)).resolves.toEqual([
      { type: "text", text: mixed },
      image("image/png", PNG),
    ]);
  });
});
