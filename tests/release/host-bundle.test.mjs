import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditHostBundleMetafile,
  auditHostBundleSource,
  buildReleaseHostBundle,
} from "../../packages/host-runtime/scripts/build-release.mjs";

function validMetafile(extraInputs = {}) {
  return {
    inputs: {
      "packages/host-runtime/src/release-main.ts": {},
      "packages/host-runtime/src/app-server-host.ts": {},
      "packages/adapters/pi/dist/index.js": {},
      "node_modules/diff/lib/index.mjs": {},
      "node_modules/zod/index.js": {},
      ...extraInputs,
    },
  };
}

describe("release Host Bundle", () => {
  it("accepts the reviewed Pi-only input closure", () => {
    expect(auditHostBundleMetafile(validMetafile())).toMatchObject({
      runtimePackages: ["diff", "zod"],
    });
  });

  it("rejects Claude and unreviewed runtime inputs", () => {
    expect(() =>
      auditHostBundleMetafile(validMetafile({ "packages/adapters/claude-code/dist/index.js": {} })),
    ).toThrow("forbidden inputs");
    expect(() =>
      auditHostBundleMetafile(validMetafile({ "node_modules/unreviewed/index.js": {} })),
    ).toThrow("unreviewed runtime packages: unreviewed");
    expect(() => auditHostBundleSource('import "@anthropic-ai/claude-agent-sdk"')).toThrow(
      "forbidden references",
    );
  });

  it("rejects a closure missing the Pi Adapter", () => {
    const inputs = { ...validMetafile().inputs };
    delete inputs["packages/adapters/pi/dist/index.js"];
    expect(() => auditHostBundleMetafile({ inputs })).toThrow(
      "missing required input: /packages/adapters/pi/",
    );
  });

  it("builds the real Pi-only entry without Claude dependencies", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-host-bundle-"));
    const outputPath = path.join(directory, "host-runtime.mjs");
    try {
      const audit = await buildReleaseHostBundle({
        repositoryRoot: path.resolve(import.meta.dirname, "../.."),
        outputPath,
      });
      expect(audit.runtimePackages).toEqual(["diff", "zod"]);
      const source = await readFile(outputPath, "utf8");
      expect(source).toContain("CODEXHOST_STOCK_CODEX_PATH");
      expect(source).not.toContain("@anthropic-ai/");
      expect(source).not.toContain("@codexhost/adapter-claude-code");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
