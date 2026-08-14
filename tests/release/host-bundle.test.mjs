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
      "packages/host-runtime/src/adapter-composition.ts": {},
      "packages/adapters/pi/dist/index.js": {},
      "packages/adapters/claude-code/dist/index.js": {},
      "packages/adapters/deepseek-harness/dist/index.js": {},
      "packages/adapters/grok/dist/index.js": {},
      "node_modules/@agentclientprotocol/sdk/index.js": {},
      "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs": {},
      "node_modules/@deepseek-ai/dsh-host-apiproxy/lib/esm/fetch/client.js": {},
      "node_modules/diff/lib/index.mjs": {},
      "node_modules/zod/index.js": {},
      ...extraInputs,
    },
  };
}

describe("release Host Bundle", () => {
  it("accepts the reviewed production Adapter closure", () => {
    expect(auditHostBundleMetafile(validMetafile())).toMatchObject({
      runtimePackages: [
        "@agentclientprotocol/sdk",
        "@anthropic-ai/claude-agent-sdk",
        "@deepseek-ai/dsh-host-apiproxy",
        "diff",
        "zod",
      ],
    });
  });

  it("rejects bundled Claude Code platform packages and unreviewed runtime inputs", () => {
    expect(() =>
      auditHostBundleMetafile(
        validMetafile({
          "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/sdk.mjs": {},
        }),
      ),
    ).toThrow("forbidden inputs");
    expect(() =>
      auditHostBundleMetafile(validMetafile({ "node_modules/unreviewed/index.js": {} })),
    ).toThrow("unreviewed runtime packages: unreviewed");
    expect(() => auditHostBundleSource('//# sourceMappingURL="host-runtime.mjs.map"')).toThrow(
      "forbidden references",
    );
  });

  it("rejects a closure missing any production Adapter", () => {
    const withoutPi = { ...validMetafile().inputs };
    delete withoutPi["packages/adapters/pi/dist/index.js"];
    expect(() => auditHostBundleMetafile({ inputs: withoutPi })).toThrow(
      "missing required input: /packages/adapters/pi/",
    );

    const withoutClaude = { ...validMetafile().inputs };
    delete withoutClaude["packages/adapters/claude-code/dist/index.js"];
    expect(() => auditHostBundleMetafile({ inputs: withoutClaude })).toThrow(
      "missing required input: /packages/adapters/claude-code/",
    );

    const withoutDeepSeek = { ...validMetafile().inputs };
    delete withoutDeepSeek["packages/adapters/deepseek-harness/dist/index.js"];
    expect(() => auditHostBundleMetafile({ inputs: withoutDeepSeek })).toThrow(
      "missing required input: /packages/adapters/deepseek-harness/",
    );

    const withoutGrok = { ...validMetafile().inputs };
    delete withoutGrok["packages/adapters/grok/dist/index.js"];
    expect(() => auditHostBundleMetafile({ inputs: withoutGrok })).toThrow(
      "missing required input: /packages/adapters/grok/",
    );
  });

  it("builds the real production entry with all external Harness Adapters", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-host-bundle-"));
    const outputPath = path.join(directory, "host-runtime.mjs");
    try {
      const audit = await buildReleaseHostBundle({
        repositoryRoot: path.resolve(import.meta.dirname, "../.."),
        outputPath,
      });
      expect(audit.runtimePackages).toContain("@agentclientprotocol/sdk");
      expect(audit.runtimePackages).toContain("@anthropic-ai/claude-agent-sdk");
      expect(audit.runtimePackages).toContain("@deepseek-ai/dsh-host-apiproxy");
      const source = await readFile(outputPath, "utf8");
      expect(source).toContain("CODEXHOST_STOCK_CODEX_PATH");
      expect(source).not.toContain("--codexhost-compatibility-update");
      expect(source).toContain("Claude Code is not installed");
      expect(source).toContain("CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT");
      expect(source).not.toContain("claude-agent-sdk-darwin-arm64");
      expect(source).not.toContain("dsh-jsonrpc-agent");
      expect(source).not.toContain("runtime/cordis.yml");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
