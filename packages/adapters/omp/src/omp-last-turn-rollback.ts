import type { HarnessThinkingOptionId } from "@codexhost/shared-contracts";

import {
  mapOmpSnapshot,
  resolveOmpLastTurnBoundary,
  type OmpSessionHistory,
} from "./omp-history.js";
import { sameOmpModel, type OmpNativeModelRef } from "./omp-model-catalog.js";
import type { OmpSessionState } from "./omp-rpc-session.js";

interface OmpLastTurnRollbackTransport {
  readonly state: OmpSessionState;
  getEntries(): Promise<OmpSessionHistory>;
  fork(entryId: string): Promise<OmpSessionState>;
  selectModel(model: OmpNativeModelRef): Promise<OmpSessionState>;
  selectThinkingOption(thinkingOptionId: HarnessThinkingOptionId): Promise<OmpSessionState>;
  verifySessionCwd(expectedCwd: string): Promise<void>;
}

export type OmpLastTurnRollbackResult = { ok: false; reason: "empty" } | { ok: true };

function modelFromState(state: OmpSessionState): OmpNativeModelRef | null {
  if (state.provider === null && state.modelId === null) return null;
  if (state.provider === null || state.modelId === null) {
    throw new Error("Omp state contains a partial Model identity");
  }
  return { provider: state.provider, id: state.modelId };
}

export async function rollbackOmpLastTurn(
  transport: OmpLastTurnRollbackTransport,
  sourceSessionId: string,
  cwd: string,
): Promise<OmpLastTurnRollbackResult> {
  const startupState = transport.state;
  const startupSessionId = startupState.sessionId;
  const currentModel = modelFromState(startupState);
  const currentThinking = startupState.thinkingLevel;
  const copiedHistory = await transport.getEntries();
  const boundary = resolveOmpLastTurnBoundary(copiedHistory);
  if (!boundary) return { ok: false, reason: "empty" };

  const sourceSnapshot = mapOmpSnapshot(copiedHistory, {
    sessionId: startupSessionId,
    model: currentModel,
  });
  let state = await transport.fork(boundary.lastUserEntryId);
  if (state.sessionId === sourceSessionId || state.sessionId === startupSessionId) {
    throw new Error("Omp last-Turn rollback did not create a distinct Native Session");
  }

  if (!sameOmpModel(modelFromState(state), currentModel)) {
    if (!currentModel) throw new Error("Omp last-Turn rollback changed the current Model");
    state = await transport.selectModel(currentModel);
  }
  if (state.thinkingLevel !== currentThinking) {
    if (!currentThinking) throw new Error("Omp last-Turn rollback changed current Thinking");
    state = await transport.selectThinkingOption(currentThinking);
  }
  if (
    !sameOmpModel(modelFromState(state), currentModel) ||
    state.thinkingLevel !== currentThinking
  ) {
    throw new Error("Omp last-Turn rollback could not restore current Model and Thinking");
  }

  const snapshot = mapOmpSnapshot(await transport.getEntries(), {
    sessionId: state.sessionId,
    model: modelFromState(state),
  });
  const expectedTurnKeys = sourceSnapshot.turns
    .slice(0, -1)
    .map((turn) => turn.nativeTurnRef.nativeTurnKey);
  const actualTurnKeys = snapshot.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey);
  if (
    snapshot.turns.length !== boundary.sourceTurnCount - 1 ||
    actualTurnKeys.some((key, index) => key !== expectedTurnKeys[index])
  ) {
    throw new Error("Omp last-Turn rollback did not produce the exact retained history prefix");
  }
  await transport.verifySessionCwd(cwd);
  return { ok: true };
}
