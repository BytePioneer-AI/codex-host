import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditConsoleServerMetafile,
  buildConsoleServerBundle,
} from "../../packages/console-server/scripts/build-release.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("Console Server release bundle", () => {
  it("rejects Harness and Host Runtime inputs", () => {
    expect(() =>
      auditConsoleServerMetafile({
        inputs: {
          "packages/console-server/src/main.ts": {},
          "packages/host-runtime/src/index.ts": {},
        },
      }),
    ).toThrow("forbidden inputs");
  });

  it("bundles a standalone console entrypoint with its page script", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-console-server-"));
    try {
      const outputPath = path.join(directory, "console-server.mjs");
      await buildConsoleServerBundle({ repositoryRoot, outputPath });
      const source = await readFile(outputPath, "utf8");
      expect(source).toContain("console-web.js");
      expect(source).not.toContain("@anthropic-ai/");
      expect(source).not.toContain("@codexhost/adapter-");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
