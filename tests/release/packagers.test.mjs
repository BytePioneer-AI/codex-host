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

  it("pins WiX 4 and maps both Windows installer architectures", async () => {
    const [manifest, script, wix] = await Promise.all([
      readFile(path.join(root, "scripts/release/windows/.config/dotnet-tools.json"), "utf8"),
      readFile(path.join(root, "scripts/release/windows/package.ps1"), "utf8"),
      readFile(path.join(root, "scripts/release/windows/Product.wxs"), "utf8"),
    ]);
    expect(JSON.parse(manifest).tools.wix.version).toMatch(/^4\./u);
    expect(script).toContain('ValidateSet("x64", "arm64")');
    expect(wix).toContain('Scope="perUser"');
    for (const relative of [
      "bin\\codexhost.exe",
      "libexec\\codexhost-shim.exe",
      "runtime\\node.exe",
      "app\\host-runtime.mjs",
      "app\\renderer-extension.js",
    ]) {
      expect(wix).toContain(relative);
    }
  });
});
