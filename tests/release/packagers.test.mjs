import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

describe("platform packagers", () => {
  it("creates a standard ad-hoc signed macOS DMG", async () => {
    const source = await readFile(path.join(root, "scripts/release/macos/package.sh"), "utf8");
    expect(source).toContain('CONTENTS="$APP_PATH/Contents"');
    expect(source).toContain('RESOURCES="$CONTENTS/Resources"');
    expect(source).toContain("codesign --verify --deep --strict");
    expect(source).toContain('runtime/node" -e');
    expect(source).not.toContain("--options runtime");
    expect(source).toContain("ln -s /Applications");
    expect(source).toContain("hdiutil create");
    expect(source).toContain("hdiutil verify");
    expect(source).not.toContain("ditto -c -k");
    expect(source).not.toContain("cargo-packager");
  });

  it("produces and uploads only installable release artifacts", async () => {
    const [workflow, releaseBuilder] = await Promise.all([
      readFile(path.join(root, ".github/workflows/release-packages.yml"), "utf8"),
      readFile(path.join(root, "scripts/release/prepare-payload.mjs"), "utf8"),
    ]);
    expect(workflow).toContain("codexhost-*.dmg");
    expect(workflow).toContain("codexhost-*.msi");
    expect(workflow).not.toContain("codexhost-*.sha256");
    expect(releaseBuilder).not.toContain("checksumPath");
    expect(releaseBuilder).not.toContain("sha256=${result.checksum}");
  });

  it("pins WiX 4 and maps both Windows installer architectures", async () => {
    const [manifest, script, wix, installUi] = await Promise.all([
      readFile(path.join(root, "scripts/release/windows/.config/dotnet-tools.json"), "utf8"),
      readFile(path.join(root, "scripts/release/windows/package.ps1"), "utf8"),
      readFile(path.join(root, "scripts/release/windows/Product.wxs"), "utf8"),
      readFile(path.join(root, "scripts/release/windows/InstallUI.wxs"), "utf8"),
    ]);
    expect(JSON.parse(manifest).tools.wix.version).toMatch(/^4\./u);
    expect(script).toContain('ValidateSet("x64", "arm64")');
    expect(script).toContain("dotnet tool run wix -- --version");
    expect(script).toContain("dotnet tool run wix -- build");
    expect(script).toContain("WixToolset.UI.wixext/$ExpectedWixVersion");
    expect(script).toContain("extension add --global $WixUiExtension");
    expect(script).toContain("-ext WixToolset.UI.wixext");
    expect(wix).toContain('Scope="perUser"');
    expect(wix).toContain('<UIRef Id="CodexhostInstallUI" />');
    expect(wix).toContain('Target="[BinFolder]codexhost-start.exe"');
    expect(installUi).toContain('<DialogRef Id="WelcomeDlg" />');
    expect(installUi).toContain('<DialogRef Id="ProgressDlg" />');
    expect(installUi).toContain('Dialog="MaintenanceTypeDlg"');
    expect(installUi).not.toContain("LicenseAgreementDlg");
    const componentBodies = [...wix.matchAll(/<Component\b[^>]*>([\s\S]*?)<\/Component>/gu)].map(
      (match) => match[1],
    );
    expect(componentBodies.length).toBeGreaterThan(0);
    expect(componentBodies.every((body) => (body.match(/<File\b/gu) ?? []).length <= 1)).toBe(true);
    for (const relative of [
      "bin\\codexhost.exe",
      "bin\\codexhost-start.exe",
      "libexec\\codexhost-shim.exe",
      "runtime\\node.exe",
      "app\\desktop-controller.mjs",
      "app\\host-runtime.mjs",
      "app\\renderer-extension.js",
      "licenses\\Claude-Agent-SDK-LICENSE.md",
      "licenses\\Anthropic-SDK-LICENSE.txt",
      "licenses\\MCP-SDK-LICENSE.txt",
    ]) {
      expect(wix).toContain(relative);
    }
  });
});
