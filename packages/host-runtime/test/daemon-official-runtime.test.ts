import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createDaemonOfficialRuntime } from "../src/daemon-official-runtime.js";

describe("daemon Official invocation", () => {
  it("accepts reconnects with equivalent transport arguments and replaces idle generations for native configuration changes", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "daemon-invocation-"));
    const runtime = await createDaemonOfficialRuntime({
      environment: { CODEX_HOME: home },
      diagnosticOutput: new PassThrough(),
    });
    const attach = {
      stockCodexPath: path.resolve("/synthetic/codex"),
      arguments: [
        "-c",
        "features.code_mode_host=true",
        "app-server",
        "--analytics-default-enabled",
      ],
      defaultAgent: "codex" as const,
    };
    try {
      await runtime.attach(attach);
      const running = vi.spyOn(runtime.scope.owner, "running", "get").mockReturnValue(true);
      await expect(
        runtime.attach({ ...attach, arguments: [...attach.arguments, "--listen", "stdio://"] }),
      ).resolves.toBeUndefined();
      await expect(
        runtime.attach({ ...attach, arguments: [...attach.arguments, "--stdio"] }),
      ).resolves.toBeUndefined();
      const stop = vi.spyOn(runtime.scope.owner, "stop").mockResolvedValue();
      await expect(
        runtime.attach({ ...attach, arguments: ["app-server"] }),
      ).resolves.toBeUndefined();
      expect(stop).toHaveBeenCalledOnce();
      runtime.scope.gate.initialized();
      const finish = runtime.scope.gate.admit();
      await expect(runtime.attach(attach)).rejects.toThrow("busy");
      finish();
      stop.mockRestore();
      running.mockRestore();
    } finally {
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
