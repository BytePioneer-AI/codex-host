// Regenerate Windows ICO frames from the reviewed PNG using macOS sips.
// Usage (macOS): node scripts/release/generate-brand-icons.mjs
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const assets = path.resolve(import.meta.dirname, "../../crates/launcher/assets");
const sizes = [16, 24, 32, 48, 64, 128, 256];
const temporary = await mkdtemp(path.join(os.tmpdir(), "codexhost-icons-"));
try {
  const images = [];
  for (const size of sizes) {
    const output = path.join(temporary, `${size}.png`);
    execFileSync(
      "/usr/bin/sips",
      ["-z", String(size), String(size), path.join(assets, "codexhost.png"), "--out", output],
      { stdio: "ignore" },
    );
    images.push(await readFile(output));
  }
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  for (let index = 0; index < sizes.length; index += 1) {
    const entry = 6 + index * 16;
    directory[entry] = sizes[index] % 256;
    directory[entry + 1] = sizes[index] % 256;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(images[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  }
  await writeFile(path.join(assets, "codexhost.ico"), Buffer.concat([directory, ...images]));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
