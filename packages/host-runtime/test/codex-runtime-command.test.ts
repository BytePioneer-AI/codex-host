import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHarnessExecutable, runInstallationCommand } from "@codexhost/harness-discovery";
import type * as HarnessDiscovery from "@codexhost/harness-discovery";
import {
  CODEX_DISCOVERY_SPEC,
  resolveOfficialCodexExecutable,
} from "../src/codex-runtime/command.js";

vi.mock("@codexhost/harness-discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof HarnessDiscovery>()),
  runInstallationCommand: vi.fn(async () => "codex-cli 0.161.0"),
}));

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function installation() {
  const home = await mkdtemp(path.join(tmpdir(), "official-codex-command-"));
  directories.push(home);
  const bin = path.join(home, "bin");
  await mkdir(bin);
  const command = path.join(bin, process.platform === "win32" ? "codex.CMD" : "codex");
  await writeFile(command, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  await chmod(command, 0o700);
  return { command, environment: { HOME: home, PATH: bin } };
}

it("prefers the Desktop program over a locally installed codex", async () => {
  const { environment } = await installation();
  const desktop = path.resolve("synthetic-desktop", "codex");
  expect(await resolveOfficialCodexExecutable(desktop, environment)).toBe(desktop);
  expect(runInstallationCommand).not.toHaveBeenCalled();
});

it("refuses codexhost shim aliases and the routing proxy without executing them", async () => {
  const { command, environment } = await installation();
  const shim = path.join(path.dirname(command), "codexhost-shim");
  await writeFile(shim, "#!/bin/sh\nexit 0\n");
  await chmod(shim, 0o700);
  await rm(command);
  await symlink(shim, command);
  expect(await resolveOfficialCodexExecutable("", environment)).toBeUndefined();
  expect(await resolveOfficialCodexExecutable(command, environment)).toBeUndefined();
  expect(
    await resolveOfficialCodexExecutable(path.resolve("native-codex"), {
      ...environment,
      CODEX_CLI_PATH: path.resolve("native-codex"),
    }),
  ).toBeUndefined();
  expect(runInstallationCommand).not.toHaveBeenCalled();
});

it("rejects a local codex below 0.161.0", async () => {
  const { environment } = await installation();
  vi.mocked(runInstallationCommand).mockResolvedValueOnce("codex-cli 0.160.0");
  expect(await resolveOfficialCodexExecutable("", environment)).toBeUndefined();
});

describe("Windows npm shim discovery", () => {
  const npmDirectory = "C:\\Users\\u\\AppData\\Roaming\\npm";
  const shim = `${npmDirectory}\\codex.cmd`;
  const native = (name: string, target: string) =>
    `${npmDirectory}\\node_modules\\@openai\\${name}\\vendor\\${target}\\bin\\codex.exe`;
  const bundled = (target: string) =>
    `${npmDirectory}\\node_modules\\@openai\\codex\\bin\\codex-${target}.exe`;
  const discovery = (isExecutable: (candidate: string) => boolean) =>
    resolveHarnessExecutable(
      CODEX_DISCOVERY_SPEC,
      { environment: { PATH: npmDirectory }, platform: "win32" },
      { isExecutable },
    );

  it("resolves the .cmd shim to the platform package's native codex.exe", () => {
    const x64 = native("codex-win32-x64", "x86_64-pc-windows-msvc");
    const arm64 = native("codex-win32-arm64", "aarch64-pc-windows-msvc");
    expect(discovery((candidate) => candidate === arm64 || candidate === shim)?.executable).toBe(
      arm64,
    );
    expect(discovery((candidate) => [x64, arm64, shim].includes(candidate))?.executable).toBe(x64);
  });

  it("falls back to older releases that bundled every platform binary", () => {
    const legacy = bundled("x86_64-pc-windows-msvc");
    expect(discovery((candidate) => candidate === legacy || candidate === shim)?.executable).toBe(
      legacy,
    );
  });

  it.each([
    ["codex-win32-x64", "x86_64-pc-windows-msvc"],
    ["codex-win32-arm64", "aarch64-pc-windows-msvc"],
  ])("resolves the nested npm platform dependency %s before a hoisted copy", (name, target) => {
    const hoisted = native(name, target);
    const nested = `${npmDirectory}\\node_modules\\@openai\\codex\\node_modules\\@openai\\${name}\\vendor\\${target}\\bin\\codex.exe`;
    expect(discovery((candidate) => [nested, shim].includes(candidate))?.executable).toBe(nested);
    expect(discovery((candidate) => [nested, hoisted, shim].includes(candidate))?.executable).toBe(
      nested,
    );
  });

  it("rejects the shim instead of selecting an unusable command", () => {
    expect(discovery((candidate) => candidate === shim)).toBeUndefined();
  });

  it("keeps non-Windows candidates unchanged", () => {
    const candidate = "/usr/bin/codex";
    expect(
      resolveHarnessExecutable(
        CODEX_DISCOVERY_SPEC,
        { environment: { PATH: "/usr/bin" }, platform: "linux" },
        { isExecutable: () => true },
      )?.executable,
    ).toBe(candidate);
  });
});
