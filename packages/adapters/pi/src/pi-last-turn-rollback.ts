import { isDeepStrictEqual } from "node:util";

import { comparableHistoricalTurn } from "@codexhost/harness-adapter";
import type { HarnessThinkingOptionId } from "@codexhost/shared-contracts";

import { mapPiSnapshot, resolvePiLastTurnBoundary, type PiSessionHistory } from "./pi-history.js";
import { samePiModel, type PiNativeModelRef } from "./pi-model-catalog.js";
import type { PiSessionState } from "./pi-rpc-session.js";

interface PiLastTurnRollbackTransport {
  readonly state: PiSessionState;
  getEntries(): Promise<PiSessionHistory>;
  fork(entryId: string): Promise<PiSessionState>;
  selectModel(model: PiNativeModelRef): Promise<PiSessionState>;
  selectThinkingOption(thinkingOptionId: HarnessThinkingOptionId): Promise<PiSessionState>;
  verifySessionCwd(expectedCwd: string): Promise<void>;
}

export type PiLastTurnRollbackResult = { ok: false; reason: "empty" } | { ok: true };

function modelFromState(state: PiSessionState): PiNativeModelRef | null {
  if (state.provider === null && state.modelId === null) return null;
  if (state.provider === null || state.modelId === null) {
    throw new Error("Pi state contains a partial Model identity");
  }
  return { provider: state.provider, id: state.modelId };
}

export async function rollbackPiLastTurn(
  transport: PiLastTurnRollbackTransport,
  sourceSessionId: string,
  cwd: string,
): Promise<PiLastTurnRollbackResult> {
  const startupState = transport.state;
  const startupSessionId = startupState.sessionId;
  const currentModel = modelFromState(startupState);
  const currentThinking = startupState.thinkingLevel;
  const copiedHistory = await transport.getEntries();
  const boundary = resolvePiLastTurnBoundary(copiedHistory);
  if (!boundary) return { ok: false, reason: "empty" };

  const sourceSnapshot = mapPiSnapshot(copiedHistory, {
    sessionId: startupSessionId,
    model: currentModel,
  });
  let state = await transport.fork(boundary.lastUserEntryId);
  if (state.sessionId === sourceSessionId || state.sessionId === startupSessionId) {
    throw new Error("Pi last-Turn rollback did not create a distinct Native Session");
  }

  if (!samePiModel(modelFromState(state), currentModel)) {
    if (!currentModel) throw new Error("Pi last-Turn rollback changed the current Model");
    state = await transport.selectModel(currentModel);
  }
  if (state.thinkingLevel !== currentThinking) {
    if (!currentThinking) throw new Error("Pi last-Turn rollback changed current Thinking");
    state = await transport.selectThinkingOption(currentThinking);
  }
  if (
    !samePiModel(modelFromState(state), currentModel) ||
    state.thinkingLevel !== currentThinking
  ) {
    throw new Error("Pi last-Turn rollback could not restore current Model and Thinking");
  }

  const snapshot = mapPiSnapshot(await transport.getEntries(), {
    sessionId: state.sessionId,
    model: modelFromState(state),
  });
  const expectedTurns = sourceSnapshot.turns.slice(0, -1).map(comparableHistoricalTurn);
  if (
    snapshot.turns.length !== boundary.sourceTurnCount - 1 ||
    !isDeepStrictEqual(snapshot.turns.map(comparableHistoricalTurn), expectedTurns)
  ) {
    throw new Error("Pi last-Turn rollback did not produce the exact retained history prefix");
  }
  await transport.verifySessionCwd(cwd);
  return { ok: true };
}
