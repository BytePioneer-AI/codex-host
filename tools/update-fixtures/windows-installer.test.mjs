import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const script = fileURLToPath(new URL("./windows-installer.mjs", import.meta.url));
it("prepares only fixed digest-matched local materials, without executing a Windows installer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inno-materials-"));
  try {
    const previous = path.join(root, "old.exe"),
      next = path.join(root, "new.exe");
    const oldBytes = Buffer.from("MZsynthetic old fixture"),
      newBytes = Buffer.from("MZsynthetic next fixture");
    await writeFile(previous, oldBytes);
    await writeFile(next, newBytes);
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const common = [
      "prepare",
      "--previous",
      previous,
      "--previous-version",
      "1.2.3",
      "--previous-sha256",
      digest(oldBytes),
      "--next",
      next,
      "--next-version",
      "1.2.4",
      "--next-sha256",
      digest(newBytes),
      "--root",
      path.join(root, "installation"),
    ];
    const manifest = path.join(root, "manifest.json");
    await execute(process.execPath, [script, ...common, "--manifest", manifest]);
    expect(JSON.parse(await readFile(manifest, "utf8"))).toMatchObject({
      previous: { version: "1.2.3", sha256: digest(oldBytes) },
      next: { version: "1.2.4", sha256: digest(newBytes) },
    });
    await expect(
      execute(process.execPath, [
        script,
        ...common,
        "--previous-sha256",
        "00".repeat(32),
        "--manifest",
        path.join(root, "invalid.json"),
      ]),
    ).rejects.toThrow();
    await expect(
      execute(process.execPath, [script, "run", "--manifest", manifest], {
        env: { ...process.env, CODEXHOST_DISPOSABLE_WINDOWS_USER: "" },
      }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
