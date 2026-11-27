import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createExtensionWindows } from "../src/windows.js";

it("allows a retry after the installed window executable fails to spawn", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "extension-window-"));
  const executable = path.join(directory, "unlaunchable.exe");
  await writeFile(executable, "invalid executable", { mode: 0o600 });
  const windows = createExtensionWindows(executable, directory);
  try {
    expect(windows.available).toBe(true);
    const options = { url: "http://127.0.0.1:1234/", width: 240, height: 280 };
    await expect(windows.open(options)).rejects.toThrow();
    await expect(windows.open(options)).rejects.toThrow();
  } finally {
    await windows.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects external Host routes before launching a main window", async () => {
  const windows = createExtensionWindows(process.execPath, tmpdir(), tmpdir());
  for (const route of [
    "https://example.com/",
    "//example.com/",
    "/settings",
    "/?token=secret",
    "/\\evil",
  ])
    await expect(windows.showHost(route)).rejects.toThrow("root-relative route");
});
