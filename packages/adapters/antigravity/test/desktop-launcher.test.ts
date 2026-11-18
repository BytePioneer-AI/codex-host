import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AntigravityAdapter } from "../src/antigravity-adapter.js";
import { resolveAntigravityExecutable } from "../src/command.js";
import { createAntigravityInstallation } from "../src/installation.js";

const directories: string[] = [];
const adapters: AntigravityAdapter[] = [];
const quota = {
  event: "command_result",
  command: {
    name: "usage",
    data: {
      groups: [{ name: "Plan", buckets: [{ window: "5h", remaining_fraction: 0.75 }] }],
    },
  },
};

const nativeCli = [
  "#!/bin/sh",
  'case "$1" in',
  "  --version) echo 'agy 1.5.9' ;;",
  "  models) printf 'gemini-high\\tGemini High\\n' ;;",
  `  *) printf '%s\\n' '${JSON.stringify(quota)}' ;;`,
  "esac",
  "",
].join("\n");

async function desktopLauncher() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-desktop-"));
  directories.push(directory);
  const entry = path.join(
    directory,
    "Antigravity.app",
    "Contents",
    "Resources",
    "app",
    "bin",
    "antigravity",
  );
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(
    entry,
    [
      "#!/bin/sh",
      "ELECTRON_RUN_AS_NODE=1",
      'CLI="Resources/app/out/cli.js"',
      'if [ "$1" = "--version" ]; then',
      "  echo 'Antigravity 1.23.2'",
      "else",
      '  printf opened > "$CODEXHOST_TEST_DESKTOP_OPENED"',
      "fi",
      "",
    ].join("\n"),
  );
  await chmod(entry, 0o755);
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const alias = path.join(bin, "agy");
  await symlink(entry, alias);
  const opened = path.join(directory, "desktop-opened");
  return {
    directory,
    entry,
    alias,
    bin,
    opened,
    environment: { PATH: bin, CODEXHOST_TEST_DESKTOP_OPENED: opened },
  };
}

function adapter(options: ConstructorParameters<typeof AntigravityAdapter>[0]) {
  const result = new AntigravityAdapter(options);
  adapters.push(result);
  return result;
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((value) => value.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")("Antigravity desktop launcher discovery", () => {
  it.each(["explicit path", "environment override", "named PATH command"] as const)(
    "does not open the desktop during inspection or quota reads through %s",
    async (source) => {
      const fixture = await desktopLauncher();
      const value = adapter({
        environment: {
          ...fixture.environment,
          ...(source === "environment override"
            ? { CODEXHOST_ANTIGRAVITY_COMMAND: fixture.alias }
            : {}),
        },
        ...(source === "explicit path" ? { command: fixture.alias } : {}),
        ...(source === "named PATH command" ? { command: "agy" } : {}),
      });
      const credits = await value.refreshCredits();
      const inspection = await value.inspect({ cwd: fixture.directory });
      expect(existsSync(fixture.opened)).toBe(false);
      expect(credits).toBeNull();
      expect(inspection.status).toBe("notInstalled");
    },
  );

  it("continues past the desktop alias to the native CLI on PATH", async () => {
    const fixture = await desktopLauncher();
    const nativeBin = path.join(fixture.directory, "native-bin");
    await mkdir(nativeBin);
    const command = path.join(nativeBin, "agy");
    await writeFile(command, nativeCli);
    await chmod(command, 0o755);
    const environment = {
      ...fixture.environment,
      PATH: [fixture.bin, nativeBin].join(path.delimiter),
    };
    expect(resolveAntigravityExecutable({ environment })).toBe(command);
    const value = adapter({ environment });
    expect((await value.inspect({ cwd: fixture.directory })).status).toBe("ready");
    expect(await value.refreshCredits()).toMatchObject({ usedPercent: 25 });
    expect(existsSync(fixture.opened)).toBe(false);
  });

  it("accepts a native CLI at the same path when it is not the Electron launcher", async () => {
    const fixture = await desktopLauncher();
    await writeFile(fixture.entry, nativeCli);
    const value = adapter({ command: fixture.alias, environment: fixture.environment });
    expect((await value.inspect({ cwd: fixture.directory })).status).toBe("ready");
    expect(await value.refreshCredits()).toMatchObject({ usedPercent: 25 });
  });

  it("does not bypass a rejected desktop override with an unqualified updater command", async () => {
    const fixture = await desktopLauncher();
    const installation = createAntigravityInstallation(fixture.environment, fixture.alias, {
      fetchText: async () => JSON.stringify({ version: "2.0.0" }),
    });
    await expect(installation("update")).rejects.toThrow("Antigravity CLI (agy) is not installed");
    expect(existsSync(fixture.opened)).toBe(false);
  });
});
