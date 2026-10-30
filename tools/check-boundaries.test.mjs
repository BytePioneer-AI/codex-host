import { describe, expect, it } from "vitest";
import { findSourceBoundaryViolations } from "./check-boundaries.mjs";

const packagesDirectory = "/repo/packages";
const rendererDirectory = "/repo/packages/renderer-extension";
const sharedContractsDirectory = "/repo/packages/shared-contracts/src";

describe("source boundary checks", () => {
  it.each([
    'import { createHarnessAdapter } from "@codexhost/adapter-pi/plugin";',
    'export { packageMetadata } from "@codexhost/adapter-claude-code";',
    'const plugin = await import("@codexhost/adapter-new-agent/plugin");',
  ])("rejects concrete plugin package imports in Host source: %s", (sourceText) => {
    const violations = findSourceBoundaryViolations({
      filePath: "/repo/packages/host-runtime/src/composition.ts",
      packageRoot: "/repo/packages/host-runtime",
      packagesDirectory,
      rendererDirectory,
      sharedContractsDirectory,
      sourceText,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("Host Runtime must load installed plugins");
  });

  it("allows the generic loader and test-only plugin references", () => {
    const input = {
      packageRoot: "/repo/packages/host-runtime",
      packagesDirectory,
      rendererDirectory,
      sharedContractsDirectory,
    };
    expect(
      findSourceBoundaryViolations({
        ...input,
        filePath: "/repo/packages/host-runtime/src/loader.ts",
        sourceText: "const plugin = await import(entryUrl);",
      }),
    ).toEqual([]);
    expect(
      findSourceBoundaryViolations({
        ...input,
        filePath: "/repo/packages/host-runtime/test/plugins.test.ts",
        sourceText: 'import { warmup } from "@codexhost/adapter-pi/plugin";',
      }),
    ).toEqual([]);
  });

  it("rejects Node.js built-ins in the Renderer", () => {
    const violations = findSourceBoundaryViolations({
      filePath: "/repo/packages/renderer-extension/src/index.ts",
      packageRoot: rendererDirectory,
      packagesDirectory,
      rendererDirectory,
      sourceText: 'import { readFile } from "node:fs/promises";',
    });

    expect(violations).toContain(
      "/repo/packages/renderer-extension/src/index.ts: Renderer cannot import 'node:fs/promises'",
    );
  });

  it.each([
    "@agentclientprotocol/sdk",
    "@agentclientprotocol/sdk/internal",
    "@anthropic-ai/claude-agent-sdk",
    "@anthropic-ai/claude-agent-sdk/internal",
    "@openai/codex-sdk",
    "@openai/codex-sdk/client",
    "electron",
    "electron/renderer",
  ])("rejects forbidden Renderer package import '%s'", (specifier) => {
    const violations = findSourceBoundaryViolations({
      filePath: "/repo/packages/renderer-extension/src/index.ts",
      packageRoot: rendererDirectory,
      packagesDirectory,
      rendererDirectory,
      sourceText: `import value from ${JSON.stringify(specifier)};`,
    });

    expect(violations).toContain(
      `/repo/packages/renderer-extension/src/index.ts: Renderer cannot import '${specifier}'`,
    );
  });

  it.each([
    "@agentclientprotocol/sdk-client",
    "@anthropic-ai/claude-agent-sdk-tools",
    "@openai/codex-sdk-client",
    "electron-renderer",
  ])("allows similarly prefixed Renderer package import '%s'", (specifier) => {
    const violations = findSourceBoundaryViolations({
      filePath: "/repo/packages/renderer-extension/src/index.ts",
      packageRoot: rendererDirectory,
      packagesDirectory,
      rendererDirectory,
      sourceText: `import value from ${JSON.stringify(specifier)};`,
    });

    expect(violations).toEqual([]);
  });

  it("allows browser-safe Shared Contracts imports", () => {
    const violations = findSourceBoundaryViolations({
      filePath: "/repo/packages/shared-contracts/src/index.ts",
      packageRoot: "/repo/packages/shared-contracts",
      packagesDirectory,
      rendererDirectory,
      sharedContractsDirectory,
      sourceText: [
        'import { z } from "zod";',
        'export { jsonValueSchema } from "./json-value.js";',
      ].join("\n"),
    });

    expect(violations).toEqual([]);
  });

  it.each([
    "node:fs/promises",
    "electron/renderer",
    "@agentclientprotocol/sdk",
    "@anthropic-ai/claude-agent-sdk",
    "@openai/codex-sdk/client",
    "@earendil-works/pi-coding-agent",
    "pi-agent/core",
    "@codexhost/protocol-core",
  ])("rejects forbidden Shared Contracts import '%s'", (specifier) => {
    const violations = findSourceBoundaryViolations({
      filePath: "/repo/packages/shared-contracts/src/index.ts",
      packageRoot: "/repo/packages/shared-contracts",
      packagesDirectory,
      rendererDirectory,
      sharedContractsDirectory,
      sourceText: `import value from ${JSON.stringify(specifier)};`,
    });

    expect(violations).toContain(
      `/repo/packages/shared-contracts/src/index.ts: Shared Contracts cannot import '${specifier}'`,
    );
  });

  it("rejects relative imports into another package source tree", () => {
    const violations = findSourceBoundaryViolations({
      filePath: "/repo/packages/protocol-core/src/index.ts",
      packageRoot: "/repo/packages/protocol-core",
      packagesDirectory,
      rendererDirectory,
      sourceText: 'export { value } from "../../shared-contracts/src/index.js";',
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("cross-package source import");
  });

  it("allows imports through public Workspace package names", () => {
    const violations = findSourceBoundaryViolations({
      filePath: "/repo/packages/protocol-core/src/index.ts",
      packageRoot: "/repo/packages/protocol-core",
      packagesDirectory,
      rendererDirectory,
      sourceText: 'import { contractVersion } from "@codexhost/shared-contracts";',
    });

    expect(violations).toEqual([]);
  });
});
