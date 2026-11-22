import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findPiCliEntry, findPiPackageDirectory } from "../src/command.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-discovery-test-"));
  roots.push(root);
  return root;
}

function writePiPackage(directory: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/bundle/cli.js" } }),
  );
}

describe("Pi package discovery", () => {
  it("finds the package next to a version-manager npm shim", () => {
    const versionRoot = path.join(temporaryRoot(), "nvm", "v24.13.1");
    mkdirSync(versionRoot, { recursive: true });
    const shim = path.join(versionRoot, "pi.cmd");
    writeFileSync(shim, "@echo off\r\n");
    const packageDirectory = path.join(
      versionRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    writePiPackage(packageDirectory);

    expect(findPiPackageDirectory(shim)).toBe(packageDirectory);
    const cliEntry = path.join(packageDirectory, "dist", "bundle", "cli.js");
    mkdirSync(path.dirname(cliEntry), { recursive: true });
    writeFileSync(cliEntry, "");
    expect(findPiCliEntry(packageDirectory)).toBe(cliEntry);
  });

  it("finds the package when the executable is inside its package directory", () => {
    const packageDirectory = path.join(
      temporaryRoot(),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    const executable = path.join(packageDirectory, "dist", "cli.js");
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "");
    writePiPackage(packageDirectory);

    expect(findPiPackageDirectory(executable)).toBe(packageDirectory);
  });

  it("rejects a CLI entry that escapes the Pi package directory", () => {
    const packageDirectory = path.join(temporaryRoot(), "pi-package");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "../outside.js" } }),
    );
    writeFileSync(path.join(path.dirname(packageDirectory), "outside.js"), "");

    expect(findPiCliEntry(packageDirectory)).toBeUndefined();
  });

  it("does not treat an unrelated npm package as Pi", () => {
    const executable = path.join(temporaryRoot(), "bin", "pi.cmd");
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "@echo off\r\n");
    writeFileSync(
      path.join(path.dirname(executable), "package.json"),
      JSON.stringify({ name: "some-other-package" }),
    );

    expect(findPiPackageDirectory(executable)).toBeUndefined();
  });
});
