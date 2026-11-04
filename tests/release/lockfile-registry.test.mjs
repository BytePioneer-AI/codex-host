import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const defaultRegistry = "https://registry.npmjs.org/";

describe("package-lock.json registry", () => {
  it("resolves every remote package from the default npm registry", async () => {
    const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
    const nonDefault = Object.entries(lockfile.packages)
      .filter(([, entry]) => /^https?:\/\//.test(entry.resolved ?? ""))
      .filter(([, entry]) => !entry.resolved.startsWith(defaultRegistry))
      .map(([name, entry]) => `${name} -> ${entry.resolved}`);

    expect(nonDefault).toEqual([]);
  });
});
