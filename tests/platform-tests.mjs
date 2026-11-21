import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Look for exercised OS behavior, not imports or generic environment settings.
// Read-only fixture/source loading alone is platform-independent. Filesystem
// mutations, metadata, persistence, native commands and explicit OS paths stay.
const filesystemCalls =
  /\b(?:mkdtemp|mkdir|writeFile|appendFile|cp|copyFile|readdir|stat|lstat|realpath|access|rename|unlink|rm|rmdir|symlink|chmod|chown|exists)(?:Sync)?\s*\(|\b(?:openSync|watchFile)\s*\(|\b(?:fs|fsPromises)\.(?:open|watch|link)\s*\(/;
const platformBehavior = [
  /process\.(?:platform|execPath)\b|\b(?:win32|USERPROFILE|APPDATA|LOCALAPPDATA|PATHEXT|MappingStore)\b|\.exe\b/,
  /\b(?:homedir|tmpdir|userInfo)\s*\(|\bpath\.(?:sep|delimiter|win32|posix)\b|\b[A-Za-z]:[\\/](?!\/)/,
];

function exercisesPlatform(file, seen, helper = false) {
  const absolute = path.resolve(file);
  if (seen.has(absolute)) return false;
  seen.add(absolute);
  const source = readFileSync(absolute, "utf8");
  if (!helper) {
    if (platformBehavior.some((pattern) => pattern.test(source))) return true;
    if (source.includes("node:fs") && filesystemCalls.test(source)) return true;
  }
  if (/process\.kill\s*\(/.test(source)) return true;
  if (
    source.includes("node:child_process") &&
    /\b(?:spawn|execFile|exec|fork)(?:Sync)?\s*[()]/.test(source)
  ) {
    return true;
  }

  // Follow test helpers for subprocess launches. Incidental temporary storage
  // in a shared protocol fixture does not make every consumer an OS test.
  // Tests exercising persistence directly are selected by platformBehavior.
  const helpers = source.matchAll(/from\s+["'](\.\.?\/[^"']+\.(?:[cm]?js|ts))["']/g);
  for (const [, specifier] of helpers) {
    const dependency = path.resolve(path.dirname(absolute), specifier);
    if (/(?:\/test\/|\/tests\/)/.test(dependency.replaceAll("\\", "/"))) {
      // TS test helpers use .js specifiers for their .ts sources.
      const sourceFile = existsSync(dependency) ? dependency : dependency.replace(/\.js$/, ".ts");
      if (exercisesPlatform(sourceFile, seen, true)) return true;
    }
  }
  return false;
}

/** Shared by Vitest and the Web Host's Node test runner. */
export function isPlatformTest(file) {
  return exercisesPlatform(file, new Set());
}
