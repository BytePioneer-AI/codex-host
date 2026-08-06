#!/usr/bin/env node
// Copies the launcher icon into the macOS packaging workspace so Windows and
// macOS packages use the same reviewed codexhost artwork.
// Usage: node assets.mjs --output <directory>

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ICON_SOURCE = path.resolve(
  import.meta.dirname,
  "../../../crates/launcher/assets/codexhost.ico",
);

export function readIcon() {
  return readFileSync(ICON_SOURCE);
}

export function iconDimensions(buffer) {
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error("invalid ICO header");
  }

  const dimensions = [];
  const imageCount = buffer.readUInt16LE(4);
  for (let index = 0; index < imageCount; index += 1) {
    const offset = 6 + index * 16;
    dimensions.push({
      width: buffer[offset] || 256,
      height: buffer[offset + 1] || 256,
    });
  }
  return dimensions;
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
  await writeFile(path.join(output, "codexhost.ico"), await readFile(ICON_SOURCE));
  console.log(`icon=${path.join(output, "codexhost.ico")}`);
}
