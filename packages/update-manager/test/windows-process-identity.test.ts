import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { readWindowsProcessIdentity } from "../src/windows-process-identity.js";
import { sameWindowsPath } from "../src/windows-installation.js";

it("rejects non-integer process identities before invoking Windows", async () => {
  for (const pid of [0, -1, 1.5, Number.NaN]) {
    await expect(readWindowsProcessIdentity(pid)).rejects.toThrow("Invalid Windows process ID");
  }
});

it.skipIf(process.platform === "win32")(
  "sets UTF-8 before querying and serializing identity (portable transport fixture)",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-identity-encoding-"));
    const expected = {
      executable: path.join(root, "中文 用户", "node.exe"),
      startedAtMicros: "13312345678901234",
    };
    const powershell = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    try {
      await mkdir(path.dirname(powershell), { recursive: true });
      await writeFile(
        powershell,
        `#!/usr/bin/env node\nconst script = process.argv[process.argv.indexOf("-Command") + 1];\nif (!script || !script.includes("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)") || script.indexOf("[Console]::OutputEncoding") > script.indexOf("$p = Get-Process")) process.exit(31);\nprocess.stdout.write(JSON.stringify(${JSON.stringify(expected)}));\n`,
      );
      await chmod(powershell, 0o700);
      vi.stubEnv("SystemRoot", root);
      expect(await readWindowsProcessIdentity(process.pid)).toEqual(expected);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "preserves a native Windows executable path with Chinese characters and spaces",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-native-identity-"));
    const executable = path.join(root, "中文 空格 用户", "node.exe");
    await mkdir(path.dirname(executable), { recursive: true });
    await copyFile(process.execPath, executable);
    const child = spawn(executable, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      await once(child, "spawn");
      if (!child.pid) throw new Error("fixture PID missing");
      const identity = await readWindowsProcessIdentity(child.pid);
      expect(identity.executable).toContain("中文 空格 用户");
      expect(sameWindowsPath(identity.executable, executable)).toBe(true);
      expect(BigInt(identity.startedAtMicros)).toBeGreaterThan(0n);
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "reads native Windows creation times for exact Node instances, not an image-name group",
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(child, "spawn");
    try {
      if (!child.pid) throw new Error("fixture PID missing");
      const parent = await readWindowsProcessIdentity(process.pid);
      const instance = await readWindowsProcessIdentity(child.pid);
      expect(sameWindowsPath(instance.executable, process.execPath)).toBe(true);
      expect(BigInt(instance.startedAtMicros)).toBeGreaterThan(BigInt(parent.startedAtMicros));
      expect(await readWindowsProcessIdentity(child.pid)).toEqual(instance);
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  },
);
