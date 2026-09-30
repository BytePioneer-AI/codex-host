import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInstallation } from "../src/installation.js";

function createFakeAsar(pkg: { productName: string; version: string }): Buffer {
  const pkgContent = Buffer.from(JSON.stringify(pkg), "utf8");
  const headerObj = {
    files: {
      "package.json": {
        size: pkgContent.length,
        offset: "0",
      },
    },
  };
  const jsonBuf = Buffer.from(JSON.stringify(headerObj), "utf8");
  const jsonLen = jsonBuf.length;
  const pad = (4 - (jsonLen % 4)) % 4;
  const headerSize = 4 + 4 + jsonLen + pad;
  const headerBuf = Buffer.alloc(16);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(headerSize, 4);
  headerBuf.writeUInt32LE(jsonLen + pad + 4, 8);
  headerBuf.writeUInt32LE(jsonLen, 12);
  const padBuf = Buffer.alloc(pad, 0);
  return Buffer.concat([headerBuf, jsonBuf, padBuf, pkgContent]);
}

describe("ZCode installation discovery", () => {
  let root: string;
  const roots: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zcode-install-test-"));
    roots.push(root);
  });

  afterEach(async () => {
    for (const r of roots) {
      await rm(r, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  async function createDarwinInstall(
    dir: string,
    pkg = { productName: "ZCode", version: "3.14.4" },
  ) {
    const appDir = path.join(dir, "ZCode.app");
    const resources = path.join(appDir, "Contents", "Resources");
    const helperDir = path.join(
      appDir,
      "Contents",
      "Frameworks",
      `${pkg.productName} Helper.app`,
      "Contents",
      "MacOS",
    );
    await mkdir(resources, { recursive: true });
    await mkdir(helperDir, { recursive: true });
    await mkdir(path.join(resources, "glm"), { recursive: true });
    await mkdir(path.join(resources, "config", "provider"), { recursive: true });

    await writeFile(path.join(resources, "app.asar"), createFakeAsar(pkg));
    await writeFile(path.join(helperDir, `${pkg.productName} Helper`), "echo runtime");
    await writeFile(path.join(resources, "glm", "zcode.cjs"), "// cli");
    await writeFile(
      path.join(resources, "config", "provider", "zcode-builtin.json"),
      JSON.stringify({ revision: 1 }),
    );
    return appDir;
  }

  async function createWindowsInstall(
    dir: string,
    pkg = { productName: "ZCode", version: "3.14.4" },
  ) {
    const resources = path.join(dir, "resources");
    await mkdir(resources, { recursive: true });
    await mkdir(path.join(resources, "glm"), { recursive: true });
    await mkdir(path.join(resources, "config", "provider"), { recursive: true });

    await writeFile(path.join(resources, "app.asar"), createFakeAsar(pkg));
    await writeFile(path.join(dir, `${pkg.productName}.exe`), "echo runtime");
    await writeFile(path.join(resources, "glm", "zcode.cjs"), "// cli");
    await writeFile(
      path.join(resources, "config", "provider", "zcode-builtin.json"),
      JSON.stringify({ revision: 1 }),
    );
    return dir;
  }

  async function createLinuxInstall(
    dir: string,
    pkg = { productName: "ZCode Preview", version: "3.14.4" },
  ) {
    const resources = path.join(dir, "resources");
    const exeName = pkg.productName.toLowerCase().replace(/\s+/g, "-");
    await mkdir(resources, { recursive: true });
    await mkdir(path.join(resources, "glm"), { recursive: true });
    await mkdir(path.join(resources, "config", "provider"), { recursive: true });

    await writeFile(path.join(resources, "app.asar"), createFakeAsar(pkg));
    await writeFile(path.join(dir, exeName), "echo runtime");
    await writeFile(path.join(resources, "glm", "zcode.cjs"), "// cli");
    await writeFile(
      path.join(resources, "config", "provider", "zcode-builtin.json"),
      JSON.stringify({ revision: 1 }),
    );
    return dir;
  }

  it("resolves darwin layout with Electron Helper runtime and app.asar metadata", async () => {
    const appDir = await createDarwinInstall(root);
    const env = { HOME: root };
    const installation = await resolveInstallation(env, appDir, "darwin");

    expect(installation.version).toBe("3.14.4");
    expect(installation.runtime).toBe(
      path.join(
        appDir,
        "Contents",
        "Frameworks",
        "ZCode Helper.app",
        "Contents",
        "MacOS",
        "ZCode Helper",
      ),
    );
    expect(installation.cli).toBe(path.join(appDir, "Contents", "Resources", "glm", "zcode.cjs"));
    expect(installation.builtinProviderConfig).toBe(
      path.join(appDir, "Contents", "Resources", "config", "provider", "zcode-builtin.json"),
    );
    expect(installation.dataRoot).toBe(path.join(root, ".zcode", "v2"));
  });

  it("resolves win32 layout with <productName>.exe runtime and resources dir", async () => {
    const appDir = await createWindowsInstall(root);
    const env = { HOME: root };
    const installation = await resolveInstallation(env, appDir, "win32");

    expect(installation.version).toBe("3.14.4");
    expect(installation.runtime).toBe(path.join(appDir, "ZCode.exe"));
    expect(installation.cli).toBe(path.join(appDir, "resources", "glm", "zcode.cjs"));
    expect(installation.builtinProviderConfig).toBe(
      path.join(appDir, "resources", "config", "provider", "zcode-builtin.json"),
    );
  });

  it("resolves linux layout with lower-cased hyphenated executable and resources dir", async () => {
    const appDir = await createLinuxInstall(root, {
      productName: "ZCode Preview",
      version: "3.14.4",
    });
    const env = { HOME: root };
    const installation = await resolveInstallation(env, appDir, "linux");

    expect(installation.version).toBe("3.14.4");
    expect(installation.runtime).toBe(path.join(appDir, "zcode-preview"));
    expect(installation.cli).toBe(path.join(appDir, "resources", "glm", "zcode.cjs"));
  });

  it("resolves linux layout with standard zcode executable", async () => {
    const appDir = await createLinuxInstall(root, { productName: "ZCode", version: "3.14.0" });
    const env = { HOME: root };
    const installation = await resolveInstallation(env, appDir, "linux");

    expect(installation.version).toBe("3.14.0");
    expect(installation.runtime).toBe(path.join(appDir, "zcode"));
  });

  it("prefers Windows per-user default over per-machine default when both exist", async () => {
    const localAppData = path.join(root, "localappdata");
    const programFiles = path.join(root, "programfiles");
    const userAppDir = path.join(localAppData, "Programs", "ZCode");
    const machineAppDir = path.join(programFiles, "ZCode");

    await createWindowsInstall(userAppDir, { productName: "ZCode", version: "3.14.4" });
    await createWindowsInstall(machineAppDir, { productName: "ZCode", version: "3.14.1" });

    const env = { LOCALAPPDATA: localAppData, ProgramFiles: programFiles, HOME: root };
    const installation = await resolveInstallation(env, undefined, "win32");

    expect(installation.runtime).toBe(path.join(userAppDir, "ZCode.exe"));
    expect(installation.version).toBe("3.14.4");
  });

  it("falls back to Windows per-machine default when per-user is not present", async () => {
    const localAppData = path.join(root, "localappdata");
    const programFiles = path.join(root, "programfiles");
    const machineAppDir = path.join(programFiles, "ZCode");

    await createWindowsInstall(machineAppDir, { productName: "ZCode", version: "3.14.1" });

    const env = { LOCALAPPDATA: localAppData, ProgramFiles: programFiles, HOME: root };
    const installation = await resolveInstallation(env, undefined, "win32");

    expect(installation.runtime).toBe(path.join(machineAppDir, "ZCode.exe"));
    expect(installation.version).toBe("3.14.1");
  });

  it("rejects unsupported platforms with a clear not-installed error", async () => {
    await expect(resolveInstallation({}, undefined, "freebsd" as NodeJS.Platform)).rejects.toMatchObject({
      code: "notInstalled",
      message: expect.stringMatching(/not supported on freebsd/i),
    });
  });

  it("reports missing app.asar as not installed", async () => {
    const appDir = await createDarwinInstall(root);
    await rm(path.join(appDir, "Contents", "Resources", "app.asar"));
    await expect(resolveInstallation({}, appDir, "darwin")).rejects.toMatchObject({
      code: "notInstalled",
    });
  });

  it("reports missing CLI as not installed", async () => {
    const appDir = await createDarwinInstall(root);
    await rm(path.join(appDir, "Contents", "Resources", "glm", "zcode.cjs"));
    await expect(resolveInstallation({}, appDir, "darwin")).rejects.toMatchObject({
      code: "notInstalled",
    });
  });

  it("reports missing runtime as not installed", async () => {
    const appDir = await createDarwinInstall(root);
    await rm(
      path.join(
        appDir,
        "Contents",
        "Frameworks",
        "ZCode Helper.app",
        "Contents",
        "MacOS",
        "ZCode Helper",
      ),
    );
    await expect(resolveInstallation({}, appDir, "darwin")).rejects.toMatchObject({
      code: "notInstalled",
    });
  });

  it("reports missing builtinProviderConfig as not installed", async () => {
    const appDir = await createDarwinInstall(root);
    await rm(
      path.join(appDir, "Contents", "Resources", "config", "provider", "zcode-builtin.json"),
    );
    await expect(resolveInstallation({}, appDir, "darwin")).rejects.toMatchObject({
      code: "notInstalled",
    });
  });
});
