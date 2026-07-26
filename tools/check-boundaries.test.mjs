import { describe, expect, it } from "vitest";
import { findSourceBoundaryViolations } from "./check-boundaries.mjs";

const packagesDirectory = "/repo/packages";
const rendererDirectory = "/repo/packages/renderer-extension";

describe("source boundary checks", () => {
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
