import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { expect, it } from "vitest";

import { GrokAcpTransport } from "../src/acp-transport.js";
import { GrokAdapter } from "../src/grok-adapter.js";

it.skipIf(process.env.CODEXHOST_GROK_PERMISSION_LIVE !== "1")(
  "confirms real Grok permissions and restores the same Session without model inference",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-grok-permission-live-"));
    const grokHome = path.join(root, "grok");
    const cwd = path.join(root, "project");
    let adapter: GrokAdapter | undefined;
    try {
      await mkdir(grokHome, { mode: 0o700 });
      await mkdir(cwd);
      await copyFile(
        path.join(process.env.GROK_HOME ?? path.join(os.homedir(), ".grok"), "auth.json"),
        path.join(grokHome, "auth.json"),
      );
      const transports: GrokAcpTransport[] = [];
      adapter = new GrokAdapter(
        { environment: { ...process.env, GROK_HOME: grokHome } },
        {
          randomUUID,
          createTransport: (options) => {
            const transport = new GrokAcpTransport(options);
            transports.push(transport);
            return transport;
          },
          fetchCredits: async () => null,
        },
      );
      const opened = await adapter.open({ kind: "create", cwd });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      const ref = session.initialState.nativeRef;
      if (!ref) throw new Error("Missing native identity");
      expect(session.capabilities.configuration.permissionModeScope).toBe("live");
      for (const mode of ["always-approve", "auto", "ask", "ask"] as const) {
        expect(
          await session.execute({
            type: "permissionMode.select",
            permissionModeId: harnessPermissionModeIdSchema.parse(mode),
          }),
        ).toEqual({ ok: true, value: { completed: true } });
        expect(await session.readSnapshot()).toMatchObject({
          ok: true,
          value: { state: { effectivePermissionModeId: mode, nativeRef: ref }, turns: [] },
        });
      }
      expect(await transports[0]?.getUsage()).toMatchObject({ modelCalls: 0, numTurns: 0 });
      await session.close();
      const resumed = await adapter.open({
        kind: "resume",
        cwd,
        nativeRef: ref,
        permissionModeId: harnessPermissionModeIdSchema.parse("auto"),
      });
      if (!resumed.ok) throw new Error(resumed.error.message);
      expect(resumed.value.initialState).toMatchObject({
        nativeRef: ref,
        effectivePermissionModeId: "auto",
      });
      expect(await transports[1]?.getUsage()).toMatchObject({ modelCalls: 0, numTurns: 0 });
    } finally {
      await adapter?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
