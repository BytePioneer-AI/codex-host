import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runInstallationCommand } from "@codexhost/harness-discovery";
import type * as HarnessDiscovery from "@codexhost/harness-discovery";
import { resolveOfficialCodexExecutable } from "../src/codex-runtime/command.js";

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

it("uses local codex at the minimum supported version when Desktop is absent", async () => {
  const { command, environment } = await installation();
  expect(await resolveOfficialCodexExecutable("", environment)).toBe(command);
  expect(runInstallationCommand).toHaveBeenCalledExactlyOnceWith(
    command,
    ["--version"],
    environment,
  );
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
