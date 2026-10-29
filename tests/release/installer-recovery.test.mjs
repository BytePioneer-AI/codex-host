import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseInstallerFiles, parseInstallerSidecar } from "@codexhost/update-manager";
import {
  writeInstallerManifest,
  writeInstallerSidecar,
  fileDigest,
} from "../../scripts/release/windows/manifest.mjs";
import { buildV1Fixture } from "../../tools/update-fixtures/windows-installer-v1.mjs";
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
test("generated ownership and EXE sidecar include the actual next payload plugin file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inno-release-"));
  roots.push(root);
  const payload = path.join(root, "payload");
  const paths = [
    "bin/codexhost.exe",
    "runtime/node.exe",
    "libexec/codexhost-updater.exe",
    "app/host-runtime.mjs",
    "app/codexhost-distribution.json",
    "app/plugins/fixture-next-only/owned-software.txt",
  ];
  for (const name of paths) {
    const file = path.join(payload, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `real fixture payload ${name}`);
  }
  const text = await writeInstallerManifest(payload, "99.0.2", "windows-x64");
  const parsed = parseInstallerFiles(text);
  expect(parsed.files.map((f) => f.path)).toEqual(expect.arrayContaining(paths));
  const introduced = parsed.files.find((f) => f.path === paths[5]);
  expect(introduced.sha256).toBe(await fileDigest(path.join(payload, paths[5])));
  const exe = path.join(root, "codexhost-99.0.2-windows-x64.exe");
  await writeFile(exe, "MZ fake executable for digest-only test");
  const descriptor = await writeInstallerSidecar(exe, payload);
  const awaitedDescriptor = await readFile(descriptor, "utf8");
  expect(() =>
    parseInstallerSidecar(awaitedDescriptor, "99.0.2", "windows-x64", "ab".repeat(32)),
  ).toThrow("bind");
  expect(
    parseInstallerSidecar(awaitedDescriptor, "99.0.2", "windows-x64", await fileDigest(exe)).text,
  ).toBe(text);
});
test("original Inno recovery removes only exact obsolete files and keeps manual entry unmodified", async () => {
  const recovery = await readFile(
    new URL("../../scripts/release/windows/recovery.iss", import.meta.url),
    "utf8",
  );
  const script = await readFile(
    new URL("../../scripts/release/windows/Installer.iss", import.meta.url),
    "utf8",
  );
  expect(recovery).toContain("{param:CODEXHOSTREPLACEFILES|}");
  expect(recovery).toContain("if not RestoreRequested then exit;");
  expect(recovery).toContain("CompareText(Name, SoftwarePath(OwnFiles[J]))");
  expect(recovery).toContain("not DeleteFile(FullName)");
  expect(recovery).not.toMatch(/DelTree|RemoveDir|RmDir/u);
  expect(script).toContain("Flags: recursesubdirs createallsubdirs ignoreversion");
  expect(script.indexOf("PrepareFileRecovery;")).toBeLessThan(
    script.indexOf("ExtractTemporaryFile('codexhost-install-helper.exe')"),
  );
  expect(script).not.toContain("CloseApplications=");
  expect(script.indexOf("if Result = '' then ApplyFileReplacement;")).toBeGreaterThan(
    script.indexOf("else if ResultCode <> 0"),
  );
  expect(recovery).not.toContain("procedure CurStepChanged");
});
test.skipIf(process.platform === "win32")(
  "source fixture builder refuses non-Windows before changing versions or running tools",
  async () => {
    await expect(buildV1Fixture(process.cwd(), "unused.json")).rejects.toThrow(
      "disposable Windows",
    );
  },
);
