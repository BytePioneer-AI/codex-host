import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { consoleBuildId, consoleUrl } from "../src/open.js";

it("opens the overview containing diagnostics", () => {
  expect(consoleUrl(26339)).toBe("http://127.0.0.1:26339/");
  expect(consoleUrl(26340)).toBe("http://127.0.0.1:26340/");
});

describe("console instance identity", () => {
  it("changes when the console server or its page bundle is replaced", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-console-build-"));
    try {
      const entry = path.join(directory, "console-server.mjs");
      await writeFile(entry, "first");
      await utimes(entry, 1_000, 1_000);
      const first = await consoleBuildId(entry);
      expect(await consoleBuildId(entry)).toBe(first);
      await writeFile(entry, "second build");
      await utimes(entry, 2_000, 2_000);
      const second = await consoleBuildId(entry);
      expect(second).not.toBe(first);
      const bundle = path.join(directory, "console-web.js");
      await writeFile(bundle, "page");
      expect(await consoleBuildId(entry)).not.toBe(second);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
