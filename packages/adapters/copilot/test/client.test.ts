import { mkdtemp, cp, chmod, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCopilotClient, copilotEnvironment } from "../src/client.js";

describe("official Copilot SDK process transport (synthetic RPC peer)", () => {
  it("honors Windows environment key identity without retaining a deleted override", () => {
    const base = { Path: "base-path", GH_TOKEN: "synthetic-base", HOME: "native-home" };
    expect(
      copilotEnvironment(base, { PATH: "session-path", gh_token: undefined }, "win32"),
    ).toEqual({ PATH: "session-path", HOME: "native-home" });
    expect(base.GH_TOKEN).toBe("synthetic-base");
    expect(copilotEnvironment(base, { gh_token: undefined }, "darwin")).toEqual(base);
  });
  it("uses the explicit CLI, preserves native config, and forwards per-Session overrides", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "copilot-stdio-fixture-"));
    const command = path.join(directory, "peer with spaces & literal.js");
    await cp(new URL("./fixtures/stdio.js", import.meta.url), command);
    await chmod(command, 0o755);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CODEXHOST_COPILOT_COMMAND: command,
      CODEXHOST_COPILOT_TEST_MARKER: "base",
      CODEXHOST_COPILOT_TEST_DELETE: "base",
    };
    const client = createCopilotClient({
      cwd: directory,
      environment,
      sessionEnvironment: {
        CODEXHOST_COPILOT_TEST_MARKER: "session",
        CODEXHOST_COPILOT_TEST_DELETE: undefined,
      },
    });
    try {
      await client.start();
      const response = await client.ping();
      const facts = JSON.parse(response.message ?? "{}");
      expect(facts).toMatchObject({ marker: "session", deleted: true, home: environment.HOME });
      // Windows process.cwd() can retain an 8.3 alias that realpath expands.
      expect(await realpath(facts.cwd)).toBe(await realpath(directory));
      expect(facts.config).toBe(environment.COPILOT_HOME);
      expect(facts.keychainDisabled).toBe(environment.COPILOT_DISABLE_KEYTAR !== undefined);
      expect(facts.arguments).toEqual(
        expect.arrayContaining(["--headless", "--stdio", "--no-auto-update"]),
      );
      expect(facts.arguments).not.toContain("--no-auto-login");
      expect(environment.CODEXHOST_COPILOT_TEST_MARKER).toBe("base");
    } finally {
      await client.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
