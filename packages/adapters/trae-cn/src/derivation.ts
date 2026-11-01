import { isDeepStrictEqual } from "node:util";
import type {
  ForkSessionInput,
  RollbackLastTurnSessionInput,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import { nativeCheckpointRefSchema, type NativeSessionRef } from "@codexhost/shared-contracts";
import type { BridgeClient } from "./bridge.js";
import type { BridgeInspection } from "./protocol.js";
import { record, TraeError } from "./errors.js";
import { sameDirectory } from "./discovery.js";
import { validateReference } from "./reference.js";
import { projectHistory, TRAE_CN_ID } from "./history.js";
import { nativeModelId, nativeThinkingSelection, historyThinking } from "./models.js";
import { hasFileEditHistory } from "./file-changes.js";

function semanticTurns(snapshot: HostThreadSnapshot) {
  return snapshot.turns.map((turn) => ({
    input: turn.input,
    items: turn.items,
    outcome: turn.outcome,
    model: turn.model,
  }));
}

function scopedSnapshot(
  value: unknown,
  reference: NativeSessionRef,
  cwd: string,
): Record<string, unknown> {
  if (
    !record(value) ||
    !record(reference.locator) ||
    value.projectId !== reference.locator.projectId ||
    !Array.isArray(value.workspaceFolders) ||
    value.workspaceFolders.length !== 1 ||
    typeof value.workspaceFolders[0] !== "string" ||
    !sameDirectory(value.workspaceFolders[0], cwd)
  )
    throw new TraeError(
      "invalidRequest",
      "Native history Project or workspace does not match its reference",
    );
  return value;
}

export async function deriveSession(
  client: BridgeClient,
  inspection: BridgeInspection,
  input: ForkSessionInput | RollbackLastTurnSessionInput,
) {
  const sourceRef = input.sourceRef;
  if (
    record(sourceRef.locator) &&
    typeof sourceRef.locator.cwd === "string" &&
    !sameDirectory(sourceRef.locator.cwd, input.cwd)
  )
    throw new TraeError("unsupported", "TRAE CN cannot fork history into a different workspace");
  validateReference(sourceRef, inspection, input.cwd);
  if (inspection.history?.forkFromMessage !== true)
    throw new TraeError(
      "unsupported",
      "TRAE CN message forks are disabled or require a newer Companion",
    );
  const source = scopedSnapshot(
    await client.call("snapshot", { sessionId: sourceRef.nativeSessionId }),
    sourceRef,
    input.cwd,
  );
  if (![4, 5, 6, 7].includes(Number(source.status)))
    throw new TraeError("sessionBusy", "Native source is not idle");
  const original = projectHistory(source, sourceRef.nativeSessionId, inspection.agentType);
  if (hasFileEditHistory(source) && (input.kind === "fork" || original.turns.length > 1))
    throw new TraeError(
      "unsupported",
      "Native file-edit snapshot forks are unavailable in the verified TRAE CN version",
    );
  if (original.turns.some((t) => t.outcome.status === "unknown"))
    throw new TraeError("sessionBusy", "Native source history has an unfinished Turn");
  let prefix: HostThreadSnapshot;
  if (input.kind === "fork") {
    const checkpoint = nativeCheckpointRefSchema.safeParse(input.checkpoint);
    const index =
      checkpoint.success &&
      checkpoint.data.harnessId === TRAE_CN_ID &&
      checkpoint.data.nativeSessionId === sourceRef.nativeSessionId
        ? original.turns.findIndex(
            (t) => t.checkpoint?.checkpointId === checkpoint.data.checkpointId,
          )
        : -1;
    if (index < 0)
      throw new TraeError(
        "checkpointNotFound",
        "Native fork boundary does not belong to this source",
      );
    prefix = { turns: original.turns.slice(0, index + 1) };
  } else {
    if (!original.turns.length)
      throw new TraeError("invalidState", "Cannot roll back an empty native Session");
    prefix = { turns: original.turns.slice(0, -1) };
  }
  const model =
    (input.kind === "rollbackLastTurn" ? input.model : undefined) ?? original.turns.at(-1)?.model;
  if (!model)
    throw new TraeError("configurationRequired", "The source has no confirmed model to preserve");
  nativeModelId(inspection, model);
  const thinkingOptionId =
    (input.kind === "rollbackLastTurn" ? input.thinkingOptionId : undefined) ??
    (model.id === original.turns.at(-1)?.model?.id
      ? historyThinking(source, inspection)
      : undefined);
  if (thinkingOptionId) nativeThinkingSelection(inspection, model, thinkingOptionId);
  const boundary = prefix.turns.at(-1)?.checkpoint;
  const result = boundary
    ? await client.call("fork", {
        sessionId: sourceRef.nativeSessionId,
        messageId: boundary.checkpointId,
      })
    : await client.call("create", { cwd: input.cwd, title: "CodexHost rollback" });
  if (
    !record(result) ||
    typeof result.sessionId !== "string" ||
    !result.sessionId ||
    result.sessionId === sourceRef.nativeSessionId ||
    result.projectId !== source.projectId
  )
    throw new TraeError(
      "protocolError",
      "Native history derivation admission is uncertain; inspect existing Sessions before retrying",
    );
  const nativeRef: NativeSessionRef = { ...sourceRef, nativeSessionId: result.sessionId };
  try {
    const copied = projectHistory(
      scopedSnapshot(
        await client.call("snapshot", { sessionId: result.sessionId }),
        nativeRef,
        input.cwd,
      ),
      result.sessionId,
      inspection.agentType,
    );
    if (!isDeepStrictEqual(semanticTurns(copied), semanticTurns(prefix)))
      throw new TraeError(
        "protocolError",
        "Native derived history does not match the requested prefix",
      );
    const unchanged = await client.call("snapshot", { sessionId: sourceRef.nativeSessionId });
    if (!isDeepStrictEqual(unchanged, source))
      throw new TraeError("protocolError", "Native history derivation changed its source");
    return { nativeRef, model, ...(thinkingOptionId ? { thinkingOptionId } : {}) };
  } catch (error) {
    throw new TraeError(
      "nativeFailure",
      `Derived Session ${result.sessionId} was preserved: ${error instanceof Error ? error.message : "validation failed"}`,
    );
  }
}
