import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { harnessPermissionModeIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AntigravityAdapter } from "../src/antigravity-adapter.js";
import type {
  AntigravityAcpTransportLike,
  AntigravityAcpTransportOptions,
} from "../src/acp-types.js";
import { antigravityDelegationInstructions } from "../src/delegation.js";
import { minimalTrajectoryMetadataBlob, nativeConversationDbPath } from "../src/fork.js";
const adapters: AntigravityAdapter[] = [];
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
describe("unattended native policy", () => {
  it.each(["resume", "fork", "rollbackLastTurn"] as const)(
    "persists skip policy, environment and delegation through %s",
    async (kind) => {
      const home = await mkdtemp(path.join(os.tmpdir(), "agy-policy-"));
      homes.push(home);
      const nativeRef = nativeSessionRefSchema.parse({
        harnessId: "antigravity",
        nativeSessionId: randomUUID(),
        formatVersion: 1,
        locator: { executionPolicy: "unattended-full-access" },
      });
      const file = nativeConversationDbPath(nativeRef.nativeSessionId, home);
      await mkdir(path.dirname(file), { recursive: true });
      const db = new DatabaseSync(file);
      db.exec(
        "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER); CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT); CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB); INSERT INTO steps VALUES (0,14),(1,15),(2,14),(3,15)",
      );
      db.prepare("INSERT INTO trajectory_meta VALUES (?, ?)").run(
        randomUUID(),
        nativeRef.nativeSessionId,
      );
      db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(
        minimalTrajectoryMetadataBlob(nativeRef.nativeSessionId),
      );
      db.close();
      const creations: AntigravityAcpTransportOptions[] = [];
      const opens: unknown[] = [];
      const adapter = new AntigravityAdapter({
        environment: {
          HOME: home,
          USERPROFILE: home,
          CODEXHOST_CLI_PATH: "private-cli",
          CODEXHOST_RUNTIME_ENDPOINT: "private-endpoint",
          CODEXHOST_RUNTIME_TOKEN: "private-token",
          CODEXHOST_THREAD_ID: "base",
        },
        createTransport: (options): AntigravityAcpTransportLike => {
          creations.push(options);
          return {
            sessionId: null,
            isClosed: false,
            skipPermissions: options.skipPermissions === true,
            initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
            setSessionEventHandler: () => {},
            openSession: async (input) => {
              opens.push(input);
              return { opened: { sessionId: input.sessionId ?? randomUUID() }, replayedEvents: [] };
            },
            setMode: async () => {},
            setConfigOption: async () => [],
            prompt: async () => ({ stopReason: "end_turn" }),
            cancel: async () => {},
            closeSession: async () => {},
            close: async () => {},
          };
        },
      });
      adapters.push(adapter);
      const common = { cwd: home, environment: { CODEXHOST_THREAD_ID: "derived" } };
      const result = await adapter.open(
        kind === "resume"
          ? { ...common, kind, nativeRef }
          : kind === "fork"
            ? {
                ...common,
                kind,
                sourceRef: nativeRef,
                checkpoint: { ...nativeRef, checkpointId: "turn-0" },
              }
            : { ...common, kind, sourceRef: nativeRef },
      );
      expect(result.ok).toBe(true);
      expect(creations).toHaveLength(1);
      expect(creations[0]).toMatchObject({
        skipPermissions: true,
        environment: { CODEXHOST_THREAD_ID: "derived" },
      });
      expect(opens[0]).toMatchObject({
        kind: "resume",
        cwd: home,
        systemPromptAppend: expect.stringContaining("CODEXHOST_RUNTIME_TOKEN"),
      });
      expect(JSON.stringify(opens)).not.toContain("private-token");
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.initialState.nativeRef?.locator).toMatchObject({
        executionPolicy: "unattended-full-access",
      });
      expect(
        await result.value.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
        }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    },
  );
  it("does not advertise delegation with an incomplete environment", () => {
    expect(
      antigravityDelegationInstructions({
        CODEXHOST_CLI_PATH: "private-cli",
        CODEXHOST_RUNTIME_TOKEN: "secret",
      }),
    ).toBeUndefined();
  });
});
