import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { OpenSessionInput } from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { DevinAdapter } from "../src/adapter.js";
import { DEVIN_CAPABILITIES, devinModelRef } from "../src/models.js";
import { devinSnapshot } from "../src/projection.js";
import { DevinTransport } from "../src/transport.js";

vi.mock("../src/transport.js", () => ({
  DevinTransport: vi.fn(function () {
    throw new Error("Native access is forbidden in history gate tests");
  }),
}));

afterEach(() => vi.clearAllMocks());

const sourceRef = nativeSessionRefSchema.parse({
  harnessId: "devin",
  nativeSessionId: "history-source",
  formatVersion: 1,
});
const cwd = "/synthetic/workspace";

describe("Devin history safety boundary", () => {
  it("keeps all derivation capabilities disabled without a verified exact-boundary protocol", () => {
    expect(DEVIN_CAPABILITIES.history).toEqual({
      fork: false,
      forkAcrossCwd: false,
      rollbackLastTurn: false,
    });
  });

  it.each([
    { name: "middle", checkpointId: "turn-1" },
    { name: "tail", checkpointId: "turn-2" },
    { name: "unknown", checkpointId: "missing" },
    { name: "foreign session", checkpointId: "turn-1", nativeSessionId: "other-session" },
    { name: "foreign Harness", checkpointId: "turn-1", harnessId: "pi" },
    { name: "cross-cwd", checkpointId: "turn-1", cwd: "/synthetic/other-workspace" },
  ])("rejects $name fork before native access", async (boundary) => {
    const adapter = new DevinAdapter({ environment: {} });
    try {
      expect(
        await adapter.open({
          kind: "fork",
          sourceRef,
          checkpoint: nativeCheckpointRefSchema.parse({
            harnessId: boundary.harnessId ?? "devin",
            nativeSessionId: boundary.nativeSessionId ?? sourceRef.nativeSessionId,
            checkpointId: boundary.checkpointId,
            formatVersion: 1,
          }),
          cwd: boundary.cwd ?? cwd,
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported", retryable: false } });
      expect(DevinTransport).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });

  it.each([false, true])(
    "rejects rollback before native access (configuration: %s)",
    async (configured) => {
      const adapter = new DevinAdapter({ environment: {} });
      const input: OpenSessionInput = {
        kind: "rollbackLastTurn",
        sourceRef,
        cwd,
        ...(configured
          ? {
              model: devinModelRef("synthetic-model"),
              thinkingOptionId: harnessThinkingOptionIdSchema.parse("synthetic-thinking"),
              permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
            }
          : {}),
      };
      try {
        expect(await adapter.open(input)).toMatchObject({
          ok: false,
          error: { code: "unsupported", retryable: false },
        });
        expect(DevinTransport).not.toHaveBeenCalled();
      } finally {
        await adapter.close();
      }
    },
  );

  it("does not turn stable replayed Turn identities into forkable checkpoints", () => {
    const replay: SessionNotification[] = ["turn-1", "turn-2"].flatMap((key) => [
      {
        sessionId: sourceRef.nativeSessionId,
        update: {
          sessionUpdate: "user_message_chunk" as const,
          content: { type: "text" as const, text: key },
          _meta: { "cognition.ai/clientMessageId": key },
        },
      },
      {
        sessionId: sourceRef.nativeSessionId,
        update: {
          sessionUpdate: "agent_message_chunk" as const,
          content: { type: "text" as const, text: "answer" },
        },
      },
    ]);
    const original = structuredClone(replay);
    const snapshot = devinSnapshot(sourceRef.nativeSessionId, replay);
    expect(snapshot.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
      "turn-1",
      "turn-2",
    ]);
    for (const turn of snapshot.turns) expect(turn).not.toHaveProperty("checkpoint");
    expect(devinSnapshot(sourceRef.nativeSessionId, replay)).toEqual(snapshot);
    expect(replay).toEqual(original);
  });
});
