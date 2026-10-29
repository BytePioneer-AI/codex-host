import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, symlink, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  installerFilesText,
  parseInstallerFiles,
  INSTALLER_FILES_PATH,
} from "../src/installer-files.js";
import { prepareInstallerRecovery } from "../src/installer-materials.js";
import { createBackgroundUpdateManager } from "../src/update-manager.js";
import {
  fetchGitHubReleaseVersion,
  parseLatestGitHubRelease,
  type CodexhostLatestRelease,
} from "../src/github-release.js";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
test("exact original-version lookup accepts an installed prerelease without changing stable latest selection", async () => {
  const value = {
    draft: false,
    prerelease: true,
    tag_name: "v1.2.3-rc.1",
    html_url: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3-rc.1",
    body: null,
    assets: [],
  };
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(value), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect((await fetchGitHubReleaseVersion("1.2.3-rc.1")).version).toBe("1.2.3-rc.1");
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    "https://api.github.com/repos/BytePioneer-AI/codex-host/releases/tags/v1.2.3-rc.1",
  );
  expect(() => parseLatestGitHubRelease(value)).toThrow();
});
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "inno-manifest-")));
  roots.push(root);
  const install = path.join(root, "中文 安装"),
    operation = path.join(root, "operation");
  await mkdir(install);
  await mkdir(operation);
  const names = [
    "bin/codexhost.exe",
    "runtime/node.exe",
    "libexec/codexhost-updater.exe",
    "app/host-runtime.mjs",
    "app/codexhost-distribution.json",
  ];
  const inventory = async (version: string, extra: boolean) => {
    const files = [];
    for (const name of [...names, ...(extra ? ["app/plugins/next-only/plugin.mjs"] : [])]) {
      const bytes = name.endsWith("distribution.json")
        ? JSON.stringify({
            schemaVersion: 1,
            version,
            distribution: "installer",
            target: "windows-x64",
          })
        : `${version} software`;
      files.push({ path: name, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) });
      if (!extra) {
        const file = path.join(install, name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, bytes);
      }
    }
    return installerFilesText({ version, target: "windows-x64", files });
  };
  const old = await inventory("1.2.3", false),
    next = await inventory("1.2.4", true);
  await writeFile(path.join(install, INSTALLER_FILES_PATH), old);
  const artifacts = new Map<string, Buffer>();
  const releases = new Map<string, CodexhostLatestRelease>();
  for (const [version, files] of [
    ["1.2.3", old],
    ["1.2.4", next],
  ] as const) {
    const base = `https://github.com/BytePioneer-AI/codex-host/releases/download/v${version}/`,
      exe = Buffer.from(`${version} original Inno`);
    const descriptor = Buffer.from(
      JSON.stringify({ schemaVersion: 1, installerSha256: hash(exe), files }),
    );
    const assets = [
      ["exe", exe],
      ["installer-recovery-v1.json", descriptor],
    ].map(([suffix, bytes]) => {
      const name = `codexhost-${version}-windows-x64.${suffix}`,
        downloadUrl = base + name;
      artifacts.set(downloadUrl, bytes as Buffer);
      return {
        name,
        downloadUrl,
        size: (bytes as Buffer).length,
        digest: `sha256:${hash(bytes as Buffer)}`,
      };
    });
    releases.set(version, {
      version,
      releaseNotes: null,
      releaseNotesUrl: `https://github.com/BytePioneer-AI/codex-host/releases/tag/v${version}`,
      assets,
    });
  }
  const artifact = {
    url: "https://github.com/BytePioneer-AI/codex-host/releases/download/v1.2.4/codexhost-1.2.4-windows-x64.exe",
    sha256: hash(Buffer.from("1.2.4 original Inno")),
  };
  const options = {
    installRoot: install,
    operation,
    installedVersion: "1.2.3",
    version: "1.2.4",
    architecture: "x64",
    artifact,
    environment: {
      CODEXHOST_DATA_DIR: path.join(install, "user-data"),
      CODEXHOST_PLUGIN_DIRECTORY: path.join(install, "app/plugins/user"),
    },
    release: async (version: string) => present(releases.get(version)),
    download: async (source: { url: string; sha256: string }, name: string) => {
      const bytes = present(artifacts.get(source.url));
      expect(hash(bytes)).toBe(source.sha256);
      const file = path.join(operation, name);
      await writeFile(file, bytes, { flag: "wx" });
      return file;
    },
  };
  return { root, install, operation, old, next, artifacts, releases, artifact, options };
}
test("prepares exact offline original-channel EXE and both published manifests without touching user plugins/data", async () => {
  const f = await fixture(),
    user = path.join(f.install, "app/plugins/user/state.json");
  await mkdir(path.dirname(user), { recursive: true });
  await writeFile(user, "user");
  const recovery = await prepareInstallerRecovery(f.options);
  expect(await readFile(recovery.installer_path, "utf8")).toBe("1.2.3 original Inno");
  expect(await readFile(recovery.replacement_files_path, "utf8")).toBe(f.next);
  expect(await readFile(path.join(f.operation, "previous-files.txt"), "utf8")).toBe(f.old);
  expect(await readFile(user, "utf8")).toBe("user");
  expect(await readFile(path.join(f.install, INSTALLER_FILES_PATH), "utf8")).toBe(f.old);
});
test.each(["collision", "overlap", "modified", "legacy", "link", "hardlink"])(
  "refuses %s before an installer or owner shutdown",
  async (condition) => {
    const f = await fixture();
    if (condition === "collision") {
      const p = path.join(f.install, "app/plugins/next-only/plugin.mjs");
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, "user");
    }
    if (condition === "overlap")
      f.options.environment.CODEXHOST_PLUGIN_DIRECTORY = path.join(f.install, "app/plugins");
    if (condition === "modified")
      await writeFile(path.join(f.install, "app/host-runtime.mjs"), "edited bundled runtime");
    if (condition === "legacy") await rm(path.join(f.install, INSTALLER_FILES_PATH));
    if (condition === "hardlink")
      await link(path.join(f.install, "app/host-runtime.mjs"), path.join(f.root, "user-alias"));
    if (condition === "link") {
      const outside = path.join(f.root, "outside");
      await mkdir(outside);
      await mkdir(path.join(f.install, "app/plugins"), { recursive: true });
      await symlink(
        outside,
        path.join(f.install, "app/plugins/next-only"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    await expect(prepareInstallerRecovery(f.options)).rejects.toThrow();
    expect(await readFile(path.join(f.install, "bin/codexhost.exe"), "utf8")).toBe(
      "1.2.3 software",
    );
  },
);
test("rejects ambiguous/extra-field/incorrect EXE bindings", async () => {
  const f = await fixture();
  for (const entry of ["app/../x", "app/NUL.txt", "app/a.", "app/a:stream"])
    expect(() => parseInstallerFiles(f.old.replace("app/host-runtime.mjs", entry))).toThrow();
  const descriptor = present(present(f.releases.get("1.2.3")).assets[1]);
  f.artifacts.set(descriptor.downloadUrl, Buffer.from("{}"));
  await expect(prepareInstallerRecovery(f.options)).rejects.toThrow();
});
test("manager publishes verified recovery and delegates Windows start through its Launcher", async () => {
  const f = await fixture();
  const state = path.join(f.root, "updates");
  const manager = createBackgroundUpdateManager({
    platform: "win32",
    architecture: "x64",
    environment: f.options.environment,
    installerRelease: f.options.release,
    readProcessIdentity: async () => ({
      executable: path.join(f.install, "bin/codexhost.exe"),
      startedAtMicros: "12345678901234567",
    }),
    download: async (source, destination) => {
      const bytes = present(f.artifacts.get(source.url));
      await writeFile(destination, bytes, { flag: "wx" });
      return { bytes: bytes.length, finalUrl: source.url };
    },
  });
  const prepared = await manager.prepareWindowsInstaller({
    version: "1.2.4",
    installedVersion: "1.2.3",
    launcherPid: 1234,
    launcherExecutable: path.join(f.install, "bin/codexhost.exe"),
    runtimeDescriptorPath: path.join(f.root, "runtime.json"),
    updaterExecutable: path.join(f.install, "libexec/codexhost-updater.exe"),
    stateDirectory: state,
    installRoot: f.install,
    artifact: f.artifact,
  });
  const request = JSON.parse(await readFile(prepared.requestPath, "utf8"));
  expect(request.installation.recovery.installer_path).toContain("previous.exe");
  await expect(manager.start(prepared)).resolves.not.toHaveProperty("updaterPid");
  expect(JSON.parse(await readFile(prepared.requestPath, "utf8"))).toHaveProperty(
    "launch_via_launcher",
    true,
  );
});
