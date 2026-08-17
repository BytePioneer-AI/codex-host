import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditDesktopControllerMetafile,
  buildDesktopControllerBundle,
} from "../../packages/desktop-control/scripts/build-release.mjs";

function validMetafile(extraInputs = {}) {
  return {
    inputs: {
      "packages/desktop-control/src/release-main.ts": {},
      "packages/desktop-control/src/production-controller.ts": {},
      "packages/desktop-control/src/renderer-control-session.ts": {},
      "packages/desktop-control/src/controller-attachment-server.ts": {},
      "packages/desktop-control/src/main-process-title-policy.ts": {},
      "packages/desktop-control/src/renderer-draft-prewarm-policy.ts": {},
      ...extraInputs,
    },
  };
}

describe("Desktop Controller release Bundle", () => {
  it("accepts the reviewed production closure", () => {
    expect(auditDesktopControllerMetafile(validMetafile()).inputs).toHaveLength(6);
  });

  it("rejects Tool, Test, and Claude inputs", () => {
    for (const input of [
      "tools/renderer-binding/run.mjs",
      "packages/desktop-control/test/controller.test.ts",
      "packages/adapters/claude-code/dist/index.js",
    ]) {
      expect(() => auditDesktopControllerMetafile(validMetafile({ [input]: {} }))).toThrow(
        "forbidden inputs",
      );
    }
  });

  it("builds the real Controller without development inputs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-desktop-controller-"));
    const outputPath = path.join(directory, "desktop-controller.mjs");
    try {
      const audit = await buildDesktopControllerBundle({
        repositoryRoot: path.resolve(import.meta.dirname, "../.."),
        outputPath,
      });
      expect(audit.inputs).toContain("packages/desktop-control/src/release-main.ts");
      const source = await readFile(outputPath, "utf8");
      expect(source).toContain("codexhost Desktop Controller");
      expect(source).toContain("installRendererControlSession");
      expect(source).toContain("schemaVersion: 2");
      expect(source).not.toContain("detection-failed");
      expect(source).not.toContain("agent-routing-structure-unavailable");
      expect(source).not.toContain("unreviewed-title-service-identity");
      expect(source).not.toContain('process.stdout.write("ready\\n")');
      expect(source).not.toContain("tools/renderer-binding");
      expect(source).not.toContain("@anthropic-ai/");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
