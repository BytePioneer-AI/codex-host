import { crc32, inflateRaw } from "node:zlib";
import { promisify } from "node:util";

const inflate = promisify(inflateRaw);
const LIMIT = 16 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const check = (condition, message) => {
  if (!condition) throw new Error(`Invalid pet package: ${message}`);
};

export function imageInfo(bytes) {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  )
    return { mime: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X")
      return {
        mime: "image/webp",
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    if (kind === "VP8L" && bytes[20] === 47) {
      const packed = bytes.readUInt32LE(21);
      return {
        mime: "image/webp",
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1,
      };
    }
    if (kind === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42])))
      return {
        mime: "image/webp",
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
  }
  throw new Error("Expected a PNG or WebP sprite image");
}

function safePath(value) {
  check(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 512 &&
      !/[\\\x00-\x1f:<>"|?*]/u.test(value),
    "unsafe path",
  );
  check(
    !value.startsWith("/") &&
      value
        .split("/")
        .every((part) => part && part !== "." && part !== ".." && !/[. ]$/u.test(part)),
    "unsafe path",
  );
  return value;
}

export async function readPetArchive(zip) {
  check(Buffer.isBuffer(zip) && zip.length >= 22 && zip.length <= LIMIT, "archive size");
  let end = zip.length - 22;
  const earliest = Math.max(0, end - 65535);
  while (
    end >= earliest &&
    (zip.readUInt32LE(end) !== 0x06054b50 || end + 22 + zip.readUInt16LE(end + 20) !== zip.length)
  )
    end--;
  check(end >= earliest, "missing ZIP directory");
  const count = zip.readUInt16LE(end + 10);
  const directory = zip.readUInt32LE(end + 16);
  check(
    zip.readUInt16LE(end + 4) === 0 &&
      zip.readUInt16LE(end + 6) === 0 &&
      zip.readUInt16LE(end + 8) === count,
    "multi-disk ZIP",
  );
  check(
    count > 0 && count <= 256 && directory + zip.readUInt32LE(end + 12) === end,
    "ZIP directory bounds",
  );
  let offset = directory;
  let total = 0;
  const entries = [];
  const names = new Set();
  for (let index = 0; index < count; index++) {
    check(offset + 46 <= end && zip.readUInt32LE(offset) === 0x02014b50, "ZIP entry header");
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const checksum = zip.readUInt32LE(offset + 16);
    const compressed = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameSize = zip.readUInt16LE(offset + 28);
    const next =
      offset + 46 + nameSize + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    check(
      next <= end && (flags & ~0x080e) === 0 && (method === 0 || method === 8),
      "unsupported ZIP compression",
    );
    const rawName = zip.subarray(offset + 46, offset + 46 + nameSize);
    const original = utf8.decode(rawName);
    const isDirectory = original.endsWith("/");
    const name = safePath(isDirectory ? original.slice(0, -1) : original);
    const canonical = name.normalize("NFC").toLowerCase();
    check(!names.has(canonical), "duplicate path");
    names.add(canonical);
    const mode = (zip.readUInt32LE(offset + 38) >>> 16) & 0xf000;
    check(mode === 0 || mode === (isDirectory ? 0x4000 : 0x8000), "symlink or special file");
    const local = zip.readUInt32LE(offset + 42);
    check(local + 30 <= directory && zip.readUInt32LE(local) === 0x04034b50, "local header");
    check(
      zip.readUInt16LE(local + 6) === flags &&
        zip.readUInt16LE(local + 8) === method &&
        zip.readUInt16LE(local + 26) === nameSize,
      "inconsistent local header",
    );
    check(
      zip.subarray(local + 30, local + 30 + nameSize).equals(rawName),
      "inconsistent file name",
    );
    const start = local + 30 + nameSize + zip.readUInt16LE(local + 28);
    check(
      start + compressed <= directory && size <= 8 * 1024 * 1024 && (!isDirectory || size === 0),
      "entry size",
    );
    total += size;
    check(total <= LIMIT, "unpacked size");
    if (!isDirectory) entries.push({ name, checksum, size, method, start, compressed });
    offset = next;
  }
  check(offset === end, "directory length");
  const files = new Map();
  for (const entry of entries) {
    if (
      !/(?:\.json|\.png|\.webp|\.txt|\.md|(?:^|\/)(?:licen[cs]e|copying|notice)(?:\.[^/]+)?)$/iu.test(
        entry.name,
      )
    )
      continue;
    const input = zip.subarray(entry.start, entry.start + entry.compressed);
    const bytes =
      entry.method === 0
        ? input
        : await inflate(input, { maxOutputLength: Math.max(1, entry.size) });
    check(bytes.length === entry.size && crc32(bytes) === entry.checksum, "CRC or size mismatch");
    files.set(entry.name, bytes);
  }
  const manifests = [...files.keys()].filter((name) => /(?:^|\/)pet\.json$/iu.test(name));
  check(manifests.length === 1, "expected one pet.json");
  const manifestPath = manifests[0];
  const raw = files.get(manifestPath);
  check(raw.length <= 32 * 1024, "manifest size");
  const manifest = JSON.parse(utf8.decode(raw));
  safePath(manifest.spritesheetPath);
  check(/\.(?:png|webp)$/iu.test(manifest.spritesheetPath), "sprite format");
  const prefix = manifestPath.slice(0, -8);
  const image = files.get(prefix + manifest.spritesheetPath);
  check(image, "missing sprite image");
  const info = imageInfo(image);
  check(
    info.width === 1536 && (info.height === 1872 || info.height === 2288),
    "expected an 8-column Codex sprite atlas",
  );
  const version = info.height === 2288 ? 2 : 1;
  check(
    manifest.spriteVersionNumber === undefined || manifest.spriteVersionNumber === version,
    "sprite version and dimensions disagree",
  );
  const licenses = [...files.entries()]
    .filter(([name]) => /(?:license|licence|copying|notice)/iu.test(name))
    .map(([name, value]) => {
      check(value.length <= 64 * 1024, "license size");
      return { name, text: utf8.decode(value) };
    });
  check(
    licenses.reduce((size, entry) => size + Buffer.byteLength(entry.text), 0) <= 128 * 1024,
    "total license size",
  );
  return { manifest, image, mime: info.mime, version, licenses };
}
