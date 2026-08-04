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

  it("produces and uploads installers and per-target npm packages from one matrix", async () => {
    const [workflow, releaseBuilder] = await Promise.all([
      readFile(path.join(root, ".github/workflows/release-packages.yml"), "utf8"),
      readFile(path.join(root, "scripts/release/prepare-payload.mjs"), "utf8"),
    ]);
    expect(workflow).toContain("codexhost-*.dmg");
    expect(workflow).toContain("codexhost-*.exe");
    expect(workflow).toContain("npm run release:npm --");
    expect(workflow).toContain("--skip-build");
    expect(workflow).toContain("--pack");
    expect(workflow).toContain("codexhost-cli-*-${{ matrix.target }}.tgz");
    expect(workflow).toContain("Build installer package");
    expect(workflow).toContain("Build npm package");
    expect(workflow).toContain("release:npm:meta");
    expect(workflow).toContain("release:npm:publish");
    expect(workflow).toContain("secrets.NPM_TOKEN");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toContain("codexhost-*.sha256");
    expect(releaseBuilder).not.toContain("checksumPath");
    expect(releaseBuilder).not.toContain("sha256=${result.checksum}");
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
