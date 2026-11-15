import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflow = await readFile(
  new URL("../../.github/workflows/test-npm.yml", import.meta.url),
  "utf8",
);

describe("quick npm test workflow", () => {
  it("builds only Windows x64 and macOS ARM64 on an isolated test branch or manual dispatch", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain('branches:\n      - "test/npm-*"');
    expect([...workflow.matchAll(/^\s+- target: (.+)$/gmu)].map((match) => match[1])).toEqual([
      "windows-x64",
      "macos-arm64",
    ]);
    expect(workflow).not.toContain("needs:");
  });

  it("packs both local npm dependencies, verifies installation, and uploads artifacts", () => {
    expect(workflow).toContain("process.env.GITHUB_RUN_ID");
    expect(workflow).toContain("process.env.GITHUB_RUN_ATTEMPT");
    expect(workflow).toContain('npm run release:prepare -- "$version"');
    expect(workflow).toContain("--pack --skip-build");
    expect(workflow).toContain("npm run release:npm:meta");
    expect(workflow).toContain('npm install --prefix "$prefix" --offline');
    expect(workflow).toContain('@codexhost/cli/bin/codexhost.js" --version');
    expect(workflow).toContain('$PLATFORM_PACKAGE/bin/$EXECUTABLE" --version');
    expect(workflow).toContain("actions/upload-artifact@");
  });

  it("does not publish, build installers, or run the release CI gate", () => {
    for (const command of [
      "npm publish",
      "release:npm:publish",
      "release:package",
      "gh release",
      "git push",
      "resolveRelease",
      "npm run check",
      "npm run test",
      "id-token: write",
      "contents: write",
    ]) {
      expect(workflow).not.toContain(command);
    }
  });
});
