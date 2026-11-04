import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const defaultRegistry = "https://registry.npmjs.org/";

// A `resolved` value with a URL scheme (https:, git+ssh:, github:, ...) points
// at a remote source. Workspace entries use relative paths and `file:` stays local.
function isRemote(resolved) {
  return /^[a-z][a-z0-9+.-]*:/i.test(resolved) && !resolved.startsWith("file:");
}

describe("package-lock.json registry", () => {
  it("resolves every remote package from the default npm registry", async () => {
    const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
    const nonDefault = Object.entries(lockfile.packages)
      .filter(([, entry]) => typeof entry.resolved === "string" && isRemote(entry.resolved))
      .filter(([, entry]) => !entry.resolved.startsWith(defaultRegistry))
      .map(([name, entry]) => `${name} -> ${entry.resolved}`);

    expect(nonDefault).toEqual([]);
  });
});
