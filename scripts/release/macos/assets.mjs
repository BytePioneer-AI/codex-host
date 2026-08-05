#!/usr/bin/env node
// Copies the reviewed codexhost app icon master into the macOS packaging
// workspace. The source is kept as a checked-in PNG so the packaged icon and
// the in-product brand mark use the same artwork.
// Usage: node assets.mjs --output <directory>

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ICON_SOURCE = path.join(import.meta.dirname, "assets", "codexhost-icon-1024.png");

export function renderIcon() {
  return readFileSync(ICON_SOURCE);
}

export function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parseArguments(args) {
  const output = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--output") {
      output.push(args[i + 1]);
      i += 1;
    } else if (args[i].startsWith("--output=")) {
      output.push(args[i].slice("--output=".length));
    } else {
      throw new Error(`unknown asset option: ${args[i]}`);
    }
  }
  if (output.length !== 1) throw new Error("usage: node assets.mjs --output <directory>");
  return output[0];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = parseArguments(process.argv.slice(2));
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "codexhost-icon-1024.png"), await readFile(ICON_SOURCE));
  console.log(`icon=${path.join(output, "codexhost-icon-1024.png")}`);
}
