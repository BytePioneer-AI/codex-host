import { resolve } from "node:path";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("shared-contracts browser bundle", () => {
  it("bundles representative public runtime contracts for a browser target", async () => {
    const result = await build({
      bundle: true,
      format: "esm",
      logLevel: "silent",
      metafile: true,
      platform: "browser",
      target: "es2024",
      write: false,
      stdin: {
        contents: [
          'import { codexhostErrorSchema, deepSeekModernSessionImportParamsSchema, deepSeekModernSessionListResultSchema, harnessCommandDescriptorSchema, harnessInspectionSchema, harnessSessionImportCandidateSchema, harnessThinkingOptionSchema, hostThreadIdSchema, jsonRpcEnvelopeSchema, nativeSessionRefSchema, threadModelSelectParamsSchema, threadThinkingSelectParamsSchema } from "@codexhost/shared-contracts";',
          "export const schemas = { codexhostErrorSchema, deepSeekModernSessionImportParamsSchema, deepSeekModernSessionListResultSchema, harnessCommandDescriptorSchema, harnessInspectionSchema, harnessSessionImportCandidateSchema, harnessThinkingOptionSchema, hostThreadIdSchema, jsonRpcEnvelopeSchema, nativeSessionRefSchema, threadModelSelectParamsSchema, threadThinkingSelectParamsSchema };",
        ].join("\n"),
        loader: "ts",
        resolveDir: resolve(import.meta.dirname, "../../.."),
        sourcefile: "shared-contracts-browser-smoke.ts",
      },
    });

    expect(result.outputFiles).toHaveLength(1);
    expect(result.outputFiles[0]?.text.length).toBeGreaterThan(0);

    for (const inputPath of Object.keys(result.metafile.inputs)) {
      expect(inputPath).not.toMatch(/(^|[/\\])node:/u);
      expect(inputPath).not.toMatch(/electron|codex-sdk|claude-agent-sdk|pi-coding-agent/iu);
    }
  });
});
