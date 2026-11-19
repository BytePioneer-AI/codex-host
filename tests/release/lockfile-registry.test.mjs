import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const defaultRegistry = "https://registry.npmjs.org/";
// SheetJS 0.20.3 is distributed by the upstream CDN, not the npm registry.
const sheetJsTarball = "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz";

function isApprovedSource(name, resolved) {
  return (
    resolved.startsWith(defaultRegistry) ||
    (name === "node_modules/xlsx" && resolved === sheetJsTarball)
  );
}

// A `resolved` value with a URL scheme (https:, git+ssh:, github:, ...) points
// at a remote source. Workspace entries use relative paths and `file:` stays local.
function isRemote(resolved) {
  return /^[a-z][a-z0-9+.-]*:/i.test(resolved) && !resolved.startsWith("file:");
}

describe("package-lock.json registry", () => {
  it("uses the default npm registry except for the pinned upstream SheetJS tarball", async () => {
    const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
    const nonDefault = Object.entries(lockfile.packages)
      .filter(([, entry]) => typeof entry.resolved === "string" && isRemote(entry.resolved))
      .filter(([name, entry]) => !isApprovedSource(name, entry.resolved))
      .map(([name, entry]) => `${name} -> ${entry.resolved}`);

    expect(nonDefault).toEqual([]);
  });

  it.each([
    ["node_modules/xlsx", sheetJsTarball, true],
    ["node_modules/other", sheetJsTarball, false],
    ["node_modules/xlsx", "https://cdn.sheetjs.com/xlsx-0.20.4/xlsx-0.20.4.tgz", false],
    ["node_modules/xlsx", "https://registry.npmmirror.com/xlsx/-/xlsx-0.18.5.tgz", false],
    ["node_modules/other", "git+https://github.com/example/other.git", false],
    ["node_modules/other", "https://registry.npmjs.org/other/-/other-1.0.0.tgz", true],
  ])("checks the source for %s -> %s", (name, resolved, approved) => {
    expect(isApprovedSource(name, resolved)).toBe(approved);
  });
});
