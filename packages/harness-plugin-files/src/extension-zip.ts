import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { promisify } from "node:util";
import { crc32, inflateRaw, inflateRawSync } from "node:zlib";
import { DESKTOP_EXTENSION_ZIP_MAX_BYTES } from "@codexhost/shared-contracts";
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const EXPANSION_RATIO = 200;
const EXPANSION_FLOOR_BYTES = 16 * 1024 * 1024;
const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid Desktop extension ZIP: ${message}`);
}

function safeName(name: string, directory: boolean) {
  check(name.length <= 512, "entry path is too long");
  const parts = (directory ? name.slice(0, -1) : name).split("/");
  check(
    parts.every(
      (part) =>
        part &&
        part !== "." &&
        part !== ".." &&
        !/[. ]$/u.test(part) &&
        !/[\x00-\x1f\x7f\\<>:"|?*]/u.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu.test(part),
    ),
    "unsafe entry path",
  );
  return parts.join("/");
}

type ZipEntry = {
  input: Buffer;
  method: number;
  size: number;
  crc: number;
  name: string;
  directory: boolean;
};

function* indexExtensionZip(zip: Buffer, bounded: boolean): Generator<ZipEntry, void> {
  check(zip.length <= DESKTOP_EXTENSION_ZIP_MAX_BYTES, "archive exceeds the safety size limit");
  const u16 = (offset: number) => zip.readUInt16LE(offset);
  const u32 = (offset: number) => zip.readUInt32LE(offset);
  let end = zip.length - 22;
  const earliest = Math.max(0, end - 0xffff);
  while (end >= earliest && (u32(end) !== END || end + 22 + u16(end + 20) !== zip.length)) end--;
  check(end >= earliest, "missing end of central directory");
  const count = u16(end + 10);
  const start = u32(end + 16);
  check(u16(end + 4) === 0 && u16(end + 6) === 0 && u16(end + 8) === count, "multi-disk archive");
  check(start + u32(end + 12) === end, "invalid central directory bounds (ZIP64 is unsupported)");
  check(count > 0 && count <= MAX_ENTRIES, `expected 1–${MAX_ENTRIES} entries`);

  const paths = new Map<string, { name: string; directory: boolean; explicit: boolean }>();
  const ranges: { start: number; end: number }[] = [];
  let total = 0;
  let central = start;
  for (let index = 0; index < count; index++) {
    check(central + 46 <= end && u32(central) === CENTRAL, "truncated central entry");
    const flags = u16(central + 8);
    const method = u16(central + 10);
    const crc = u32(central + 16);
    const compressed = u32(central + 20);
    const size = u32(central + 24);
    const nameLength = u16(central + 28);
    const next = central + 46 + nameLength + u16(central + 30) + u16(central + 32);
    const attr = u32(central + 38);
    const type = (attr >>> 16) & 0xf000;
    const local = u32(central + 42);
    check(next <= end && u16(central + 34) === 0, "invalid central entry bounds");
    check(
      (flags & ~0x080e) === 0 && (method === 0 || method === 8),
      "unsupported ZIP flags or compression",
    );
    const rawName = zip.subarray(central + 46, central + 46 + nameLength);
    const name = utf8.decode(rawName).replaceAll("\\", "/");
    const directory = name.endsWith("/");
    check(type === 0 || type === (directory ? 0x4000 : 0x8000), "symlink or special file");
    check(directory || !(attr & 0x10), "inconsistent directory attribute");
    const relative = safeName(name, directory);
    // Check implicit parents too, so extraction behaves consistently on case-insensitive filesystems.
    const parts = relative.split("/");
    if (bounded) check(parts.length <= 32, "entry path is nested too deeply");
    for (let i = 1; i <= parts.length; i++) {
      const segment = parts.slice(0, i).join("/");
      const key = segment.normalize("NFC").toLowerCase();
      const explicit = i === parts.length;
      const isDirectory = !explicit || directory;
      const previous = paths.get(key);
      check(
        !previous ||
          (previous.name === segment &&
            previous.directory === isDirectory &&
            !(previous.explicit && explicit)),
        "duplicate or conflicting entry path",
      );
      if (!previous || explicit)
        paths.set(key, { name: segment, directory: isDirectory, explicit });
    }

    check(local + 30 <= start && u32(local) === LOCAL, "invalid local header");
    const data = local + 30 + nameLength + u16(local + 28);
    check(
      data + compressed <= start &&
        u16(local + 26) === nameLength &&
        u16(local + 6) === flags &&
        u16(local + 8) === method &&
        zip.subarray(local + 30, local + 30 + nameLength).equals(rawName),
      "local header disagrees with central directory",
    );
    let localEnd = data + compressed;
    if (flags & 8) {
      // Data descriptors may include a signature (e.g. streaming ZIP writers).
      const matches = (offset: number) =>
        offset + 12 <= start &&
        u32(offset) === crc &&
        u32(offset + 4) === compressed &&
        u32(offset + 8) === size;
      if (localEnd + 4 <= start && u32(localEnd) === 0x08074b50 && matches(localEnd + 4))
        localEnd += 16;
      else {
        check(matches(localEnd), "invalid data descriptor");
        localEnd += 12;
      }
    } else {
      check(
        u32(local + 14) === crc && u32(local + 18) === compressed && u32(local + 22) === size,
        "local entry sizes or CRC disagree",
      );
    }
    ranges.push({ start: local, end: localEnd });
    total += size;
    check(total <= MAX_UNPACKED_BYTES, "unpacked data exceeds the safety size limit");
    check(
      size <= Math.max(EXPANSION_FLOOR_BYTES, compressed * EXPANSION_RATIO),
      "entry exceeds the safety compression ratio",
    );
    check(!directory || size === 0, "directory contains file data");
    const input = zip.subarray(data, data + compressed);
    yield { input, method, size, crc, name: relative, directory };
    central = next;
  }
  check(central === end, "incorrect central directory size");
  ranges.sort((a, b) => a.start - b.start);
  let previousEnd = 0;
  for (const { start, end } of ranges) {
    check(previousEnd <= start, "overlapping local entries");
    previousEnd = end;
  }
}

function selectExtensionFiles(
  files: Map<string, Buffer>,
  subpath: string | undefined,
  zip: ZipEntry[],
) {
  const subdirectory = subpath === undefined ? undefined : safeName(subpath, false);
  if (subdirectory === undefined && files.has("manifest.json")) return files;
  const roots = new Set<string>();
  for (const { name } of zip) roots.add(name.split("/", 1)[0] ?? "");
  const [wrapper] = roots;
  const prefix = wrapper && `${wrapper}/${subdirectory ? `${subdirectory}/` : ""}`;
  check(
    roots.size === 1 && prefix && files.has(`${prefix}manifest.json`),
    subdirectory
      ? `missing manifest.json in repository subdirectory ${subdirectory}`
      : "missing manifest.json at the root or inside a single top-level directory",
  );
  const selected = new Map<string, Buffer>();
  for (const [name, bytes] of files)
    if (name.startsWith(prefix)) selected.set(name.slice(prefix.length), bytes);
  return selected;
}

function recordFile(files: Map<string, Buffer>, entry: ZipEntry, bytes: Buffer) {
  check(bytes.length === entry.size && crc32(bytes) === entry.crc, "entry size or CRC mismatch");
  if (!entry.directory) files.set(entry.name, bytes);
}

/** Preserve the synchronous Desktop installation path. */
export function readDesktopExtensionZip(zip: Buffer, subpath?: string): Map<string, Buffer> {
  const entries = [...indexExtensionZip(zip, false)];
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    const bytes =
      entry.method === 0
        ? entry.input
        : inflateRawSync(entry.input, { maxOutputLength: Math.max(1, entry.size) });
    recordFile(files, entry, bytes);
  }
  return selectExtensionFiles(files, subpath, entries);
}

const inflate = promisify(inflateRaw);
/** Validate all headers before inflating; inflate one bounded entry at a time off the event loop. */
export async function readExtensionZip(
  zip: Buffer,
  subpath?: string,
): Promise<Map<string, Buffer>> {
  const entries: ZipEntry[] = [];
  for (const entry of indexExtensionZip(zip, true)) {
    entries.push(entry);
    if (entries.length % 32 === 0) await yieldToEventLoop();
  }
  const files = new Map<string, Buffer>();
  let count = 0;
  for (const entry of entries) {
    if (++count % 32 === 0) await yieldToEventLoop();
    const bytes =
      entry.method === 0
        ? entry.input
        : await inflate(entry.input, { maxOutputLength: Math.max(1, entry.size) });
    recordFile(files, entry, bytes);
  }
  return selectExtensionFiles(files, subpath, entries);
}
