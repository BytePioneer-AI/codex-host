import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveMuseExecutable } from "../src/command.js";
import { MuseAdapter } from "../src/muse-adapter.js";

describe.skipIf(process.env.CODEXHOST_MUSE_LIVE !== "1")("muse live serve", () => {
  it("inspects and creates a Session through real muse serve", async () => {
    const executable = resolveMuseExecutable({ environment: process.env });
    expect(executable, "Install and log in to Muse before running the live gate").toBeTruthy();
    const cwd = mkdtempSync(path.join(tmpdir(), "muse-live-"));
    const adapter = new MuseAdapter({
      environment: process.env,
      serveExtraArguments: ["--no-session-log"],
    });
    try {
      const inspection = await adapter.inspect({ cwd });
      expect(inspection.status).toBe("ready");
      const opened = await adapter.open({ kind: "create", cwd });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      expect(session.initialState.nativeRef?.nativeSessionId).toBeTruthy();
      const snapshot = await session.readSnapshot();
      expect(snapshot.ok).toBe(true);
    } finally {
      await adapter.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);
});
