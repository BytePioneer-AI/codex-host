/** Immutable package-local browser artifacts shared by startup and rebuilds. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;

export function readClientSnapshot(path: string) {
  const stat = statSync(path);
  const bundle = readFileSync(path);
  const chunks = new Map<string, Buffer>();
  const hash = createHash("sha1").update(bundle);
  for (const name of readdirSync(dirname(path)).sort()) {
    if (!CHUNK.test(name)) continue;
    const bytes = readFileSync(join(dirname(path), name));
    chunks.set(name, bytes);
    hash.update(`\0${name}\0${bytes.length}:`).update(bytes);
  }
  return {
    bundle,
    chunks,
    rev: hash.digest("hex").slice(0, 12),
    baseline: { path, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size },
  };
}
