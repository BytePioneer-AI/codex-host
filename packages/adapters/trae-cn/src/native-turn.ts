import { setTimeout as delay } from "node:timers/promises";
import type {
  HarnessResult,
  HostEvent,
  HostThreadSnapshot,
  HostTurnSnapshot,
  TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  nativeSessionRefSchema,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import type { BridgeInspection } from "./protocol.js";
import { record, TraeError } from "./errors.js";
import { nativeModelId, type NativeThinkingSelection } from "./models.js";
import type { LiveItems } from "./live-items.js";
import type { NativeInteractions } from "./interactions.js";

export interface ActiveTurn {
  command: TurnStartCommand;
  model: HarnessModelRef | undefined;
  configurationRevision: number;
  thinking: NativeThinkingSelection | undefined;
  thinkingOptionId: HarnessThinkingOptionId | undefined;
  permissionModeId: string | undefined;
  permissionRevision: number;
  messageId: string;
  cancelRequested: boolean;
  admitted: boolean;
  stopRequested: boolean;
  items: LiveItems;
  interactions: NativeInteractions | undefined;
}

export function createdNativeSessionRef(
  created: unknown,
  harnessId: NativeSessionRef["harnessId"],
  inspection: BridgeInspection,
  cwd: string,
): NativeSessionRef {
  if (
    !record(created) ||
    typeof created.sessionId !== "string" ||
    typeof created.projectId !== "string"
  )
    throw new TraeError("protocolError", "Invalid native Session creation receipt");
  return nativeSessionRefSchema.parse({
    harnessId,
    nativeSessionId: created.sessionId,
    formatVersion: 1,
    locator: {
      applicationRoot: inspection.application.root,
      projectId: created.projectId,
      cwd,
      agentType: inspection.agentType,
    },
  });
}

export function nativeTurnRequest(
  inspection: BridgeInspection,
  sessionId: string,
  turn: ActiveTurn,
) {
  const model = turn.model;
  if (!model) throw new TraeError("configurationRequired", "Choose a TRAE CN model");
  return {
    sessionId,
    messageId: turn.messageId,
    modelId: nativeModelId(inspection, model),
    ...(turn.thinking ? { thinking: turn.thinking } : {}),
    ...(turn.permissionModeId ? { permissionModeId: turn.permissionModeId } : {}),
    text: turn.command.input.map((part) => part.text).join("\n"),
  };
}

export function confirmNativeTurnAdmission(
  receipt: unknown,
  messageId: string,
  permissionModeId: string | undefined,
): void {
  if (
    !record(receipt) ||
    receipt.accepted !== true ||
    receipt.messageId !== messageId ||
    receipt.fromAppend === true ||
    (permissionModeId !== undefined && receipt.permissionModeId !== permissionModeId)
  )
    throw new TraeError(
      "protocolError",
      "Native Turn admission is uncertain; read history before retrying",
    );
}

export function completeNativeTurn(
  turn: ActiveTurn,
  completed: HostTurnSnapshot,
  emit: (event: HostEvent) => void,
): void {
  if (completed.outcome.status === "unknown")
    throw new TraeError("unavailable", "Native history has not confirmed completion");
  turn.items.acceptHistory(completed.items);
  turn.items.settle(completed.outcome);
  turn.interactions?.close(completed.outcome.status === "cancelled" ? "cancelled" : "expired");
  emit({
    type: "turn.completed",
    turnId: turn.command.turnId,
    nativeTurnRef: completed.nativeTurnRef,
    outcome: completed.outcome,
  });
}

export async function readTerminal(
  messageId: string,
  closed: () => boolean,
  readSnapshot: () => Promise<HarnessResult<HostThreadSnapshot>>,
): Promise<HostTurnSnapshot> {
  const deadline = Date.now() + 5000;
  while (!closed()) {
    const snapshot = await readSnapshot();
    if (!snapshot.ok) throw new TraeError(snapshot.error.code, snapshot.error.message);
    const turn = snapshot.value.turns.find(
      (entry) => entry.nativeTurnRef.nativeTurnKey === messageId,
    );
    if (turn && turn.outcome.status !== "unknown") return turn;
    if (Date.now() >= deadline)
      throw new TraeError(
        "unavailable",
        "Native completion history is still pending; read the same Session before retrying",
      );
    // SSE EOF can precede the native history commit. Re-read this identity;
    // never restart the task or treat the visibility delay as native failure.
    await delay(100);
  }
  throw new TraeError("invalidState", "TRAE CN Session closed during history confirmation");
}
