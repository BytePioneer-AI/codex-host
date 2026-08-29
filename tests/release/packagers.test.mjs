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
    expect(source).toContain('"$ASSETS_DIR/codexhost.ico"');
    expect(source).toContain("sips -s format png");
    expect(source).toContain("iconutil -c icns");
    expect(source).toContain("CFBundleIconFile");
    expect(source).toContain("codexhost.icns");
    expect(source).toContain("create-dmg");
    expect(source).toContain("--window-size 800 400");
    expect(source).toContain("--window-pos 200 120");
    expect(source).toContain('--icon "codexhost.app" 200 190');
    expect(source).toContain("--app-drop-link 600 185");
    expect(source).toContain("installer-background.png");
    expect(source).not.toContain("layout_dmg_window");
    expect(source).not.toContain("osascript");
    expect(source).not.toContain("hdiutil convert");
    expect(source).not.toContain("ln -s /Applications");
    expect(source).toContain("hdiutil verify");
    expect(source).not.toContain("ditto -c -k");
    expect(source).not.toContain("cargo-packager");
  });

  it("publishes one tag-bound four-platform installer and npm release", async () => {
    const [workflow, releaseBuilder, releaseClient] = await Promise.all([
      readFile(path.join(root, ".github/workflows/release-packages.yml"), "utf8"),
      readFile(path.join(root, "scripts/release/prepare-payload.mjs"), "utf8"),
      readFile(path.join(root, "packages/update-manager/src/github-release.ts"), "utf8"),
    ]);
    expect(workflow).toContain('tags:\n      - "v*"');
    expect(workflow).not.toContain("types: [published]");
    expect(workflow).toContain("Resolve release metadata");
    expect(workflow).toContain("does not match package.json version");
    expect(workflow).toContain("does not match Cargo workspace version");
    expect(workflow).toContain("must be an annotated tag with release notes");
    expect(workflow).toContain("%(contents:body)");
    expect(workflow).toContain("npm_tag=test");
    expect(workflow).toContain("npm_tag=next");
    expect(workflow).toContain("npm_tag=latest");

    expect(workflow).toContain("codexhost-*.dmg");
    expect(workflow).toContain("codexhost-*.exe");
    expect(workflow).not.toContain("codexhost-*.msi");
    expect(workflow).toContain("npm run release:npm --");
    expect(workflow).toContain("Build npm package from installer outputs");
    expect(workflow).toContain("Build and smoke-test Linux npm package");
    const linuxPackageStep = workflow.slice(
      workflow.indexOf("Build and smoke-test Linux npm package"),
    );
    const linuxPackageCommand = linuxPackageStep.slice(0, linuxPackageStep.indexOf("- name:", 1));
    expect(linuxPackageCommand).toContain("scripts/release/smoke-npm-package.mjs");
    expect(linuxPackageCommand).not.toContain("--skip-build");
    expect(workflow).toContain("--skip-build");
    expect(workflow).toContain("--pack");
    expect(workflow).toContain("codexhost-cli-*-${{ matrix.target }}.tgz");
    expect(workflow).toContain("Build installer package");
    expect(workflow).toContain("if: runner.os != 'Linux'");
    expect(workflow).toContain("target: linux-x64");
    expect(workflow).toContain("runner: ubuntu-22.04");
    expect(workflow).toContain("rustTarget: x86_64-unknown-linux-gnu");
    expect(workflow).toContain("target: linux-arm64");
    expect(workflow).toContain("runner: ubuntu-22.04-arm");
    expect(workflow).toContain("rustTarget: aarch64-unknown-linux-gnu");
    expect(workflow).toContain("Build npm package");
    expect(workflow).toContain("release:npm:meta");
    expect(workflow).toContain("release:npm:publish");
    expect(workflow).toContain('--tag "$NPM_TAG"');
    expect(workflow).toContain("secrets.NPM_TOKEN");
    expect(workflow).toContain("id-token: write");

    expect(workflow).not.toContain("smoke-npm:");
    expect(workflow).not.toContain("npm view");
    expect(workflow).toContain("publish-release:");
    const publishRelease = workflow.slice(workflow.indexOf("  publish-release:"));
    expect(publishRelease).toContain("gh release create");
    expect(publishRelease).toContain('"codexhost-${VERSION}-windows-x64.exe"');
    expect(publishRelease).toContain('"codexhost-${VERSION}-windows-arm64.exe"');
    expect(publishRelease).toContain('"codexhost-${VERSION}-macos-x64.dmg"');
    expect(publishRelease).toContain('"codexhost-${VERSION}-macos-arm64.dmg"');
    expect(publishRelease).not.toContain('"codexhost-cli-${VERSION}');
    expect(workflow).not.toContain("softprops/action-gh-release");
    expect(workflow).not.toContain("codexhost-*.sha256");
    expect(workflow).not.toContain("checksums.txt");
    expect(workflow).not.toContain("update.json");
    expect(releaseBuilder).not.toContain("checksumPath");
    expect(releaseBuilder).not.toContain("sha256=${result.checksum}");
    expect(releaseClient).toContain("assets");
    expect(releaseClient).toContain("size");
    expect(releaseClient).toContain("digest");
    expect(releaseClient).toContain("sha256:");
  });

  it("builds a standard Inno Setup installer for both Windows architectures", async () => {
    const [script, installer] = await Promise.all([
      readFile(path.join(root, "scripts/release/windows/package.ps1"), "utf8"),
      readFile(path.join(root, "scripts/release/windows/Installer.iss"), "utf8"),
    ]);
    expect(script).toContain('ValidateSet("x64", "arm64")');
    expect(script).toContain("Inno Setup 6\\ISCC.exe");
    expect(script).toContain("Inno Setup build");
    expect(installer).toContain("DefaultDirName={localappdata}\\Programs\\codexhost");
    expect(installer).toContain("PrivilegesRequired=lowest");
    expect(installer).toContain("DisableProgramGroupPage=yes");
    expect(installer).toContain("ArchitecturesAllowed=x64compatible");
    expect(installer).toContain("ArchitecturesAllowed=arm64");
  });
});
