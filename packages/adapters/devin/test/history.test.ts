import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
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

  it("rejects fork before native access", async () => {
    const adapter = new DevinAdapter({ environment: {} });
    try {
      expect(
        await adapter.open({
          kind: "fork",
          sourceRef,
          checkpoint: nativeCheckpointRefSchema.parse({
            harnessId: "devin",
            nativeSessionId: sourceRef.nativeSessionId,
            checkpointId: "turn-1",
            formatVersion: 1,
          }),
          cwd: "/synthetic/other-workspace",
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported", retryable: false } });
      expect(DevinTransport).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });

  it("rejects configured rollback before native access", async () => {
    const adapter = new DevinAdapter({ environment: {} });
    try {
      expect(
        await adapter.open({
          kind: "rollbackLastTurn",
          sourceRef,
          cwd,
          model: devinModelRef("synthetic-model"),
          thinkingOptionId: harnessThinkingOptionIdSchema.parse("synthetic-thinking"),
          permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported", retryable: false } });
      expect(DevinTransport).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });

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
