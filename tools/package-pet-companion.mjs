import { deflateRawSync, crc32 } from "node:zlib";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.resolve(
  fileURLToPath(new URL("../extensions/pet-companion/", import.meta.url)),
);
const output = path.resolve(process.argv[2] ?? "dist/pet-companion.zip");
const entries = [];

async function collect(directory, relative = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const name = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${name}`);
    if (entry.isDirectory()) await collect(full, name);
    else if (entry.isFile()) entries.push({ name, bytes: await readFile(full) });
  }
}

await collect(source);
entries.push({ name: "LICENSE", bytes: await readFile(new URL("../LICENSE", import.meta.url)) });
entries.sort((left, right) => left.name.localeCompare(right.name));
if (!entries.some((entry) => entry.name === "manifest.json"))
  throw new Error("manifest.json must be at the ZIP root");
const total = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
if (total > 64 * 1024 * 1024) throw new Error("Extension source exceeds the 64 MiB package limit");

const locals = [];
const centrals = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name);
  const compressed = deflateRawSync(entry.bytes, { level: 9 });
  const local = Buffer.alloc(30);
  const central = Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(entry.bytes), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(entry.bytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(entry.bytes), 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(entry.bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  locals.push(local, name, compressed);
  centrals.push(central, name);
  offset += local.length + name.length + compressed.length;
}
const directory = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, Buffer.concat([...locals, directory, end]));
const info = await stat(output);
console.log(`${output} (${info.size} bytes, ${entries.length} files)`);
