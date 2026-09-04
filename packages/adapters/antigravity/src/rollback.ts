import { randomUUID } from "node:crypto";

import type {
  HarnessResult,
  HarnessSession,
  RollbackLastTurnSessionInput,
} from "@codexhost/harness-adapter";
import {
  nativeSessionRefSchema,
  type HarnessId,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { copyNativeConversationDbIfExists } from "./fork.js";
import { AntigravityHistory, type AntigravityTurn } from "./history.js";
import type { AntigravityPermissionMode } from "./permission-modes.js";

export interface RollbackAntigravityLastTurnOptions {
  harnessId: HarnessId;
  input: RollbackLastTurnSessionInput;
  adapterEnvironment: NodeJS.ProcessEnv;
  sourceSession?: {
    history: AntigravityHistory;
    model?: HarnessModelRef | undefined;
    thinkingOptionId?: HarnessThinkingOptionId | undefined;
    permissionMode: AntigravityPermissionMode;
    isActive: boolean;
  } | undefined;
  createSession: (params: {
    history: AntigravityHistory;
    nativeRef: NativeSessionRef;
    model?: HarnessModelRef | undefined;
    thinkingOptionId?: HarnessThinkingOptionId | undefined;
    permissionMode: AntigravityPermissionMode;
    cwd: string;
    environment: NodeJS.ProcessEnv;
  }) => HarnessSession;
}

export async function rollbackAntigravityLastTurn(
  options: RollbackAntigravityLastTurnOptions,
): Promise<HarnessResult<HarnessSession>> {
  const { harnessId, input, adapterEnvironment, sourceSession, createSession } = options;

  const sourceRefParsed = nativeSessionRefSchema.safeParse(input.sourceRef);
  if (!sourceRefParsed.success || sourceRefParsed.data.harnessId !== harnessId) {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Antigravity cannot roll back another Harness Session",
        retryable: false,
      },
    };
  }
  const sourceRef = sourceRefParsed.data;

  if (sourceSession?.isActive) {
    return {
      ok: false,
      error: {
        code: "sessionBusy",
        message: "Antigravity Session cannot roll back while a Turn is active",
        retryable: true,
      },
    };
  }

  const sessionEnvironment = input.environment ?? adapterEnvironment;
  let sourceHistory: AntigravityHistory | null = sourceSession?.history ?? null;
  if (!sourceHistory) {
    sourceHistory = await AntigravityHistory.findByNativeSessionId(
      sessionEnvironment,
      sourceRef.nativeSessionId,
    );
  }
  if (!sourceHistory) {
    return {
      ok: false,
      error: {
        code: "sessionNotFound",
        message: "Antigravity source session history not found",
        retryable: false,
      },
    };
  }

  const sourceTurns = sourceHistory.snapshot();
  if (sourceTurns.length === 0) {
    return {
      ok: false,
      error: {
        code: "invalidState",
        message: "Antigravity Native Session has no Turn to roll back",
        retryable: false,
      },
    };
  }

  const truncatedTurns = sourceTurns.slice(0, -1);
  const derivedNativeSessionId = randomUUID();
  const mappedTurns: AntigravityTurn[] = truncatedTurns.map((turn) => ({
    ...turn,
    nativeTurnRef: {
      ...turn.nativeTurnRef,
      nativeSessionId: derivedNativeSessionId,
    },
    ...(turn.checkpoint
      ? {
          checkpoint: {
            ...turn.checkpoint,
            nativeSessionId: derivedNativeSessionId,
          },
        }
      : {}),
  }));

  const model = sourceSession?.model ?? sourceHistory.model;
  const thinkingOptionId = sourceSession?.thinkingOptionId ?? sourceHistory.thinkingOptionId;
  const permissionMode = sourceSession?.permissionMode ?? "configured";

  const rolledBackHistory = await AntigravityHistory.createDerived({
    environment: sessionEnvironment,
    nativeSessionId: derivedNativeSessionId,
    turns: mappedTurns,
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  });

  await copyNativeConversationDbIfExists(sourceRef.nativeSessionId, derivedNativeSessionId);

  const derivedNativeRef: NativeSessionRef = {
    harnessId,
    nativeSessionId: derivedNativeSessionId,
    formatVersion: 1,
  };

  const session = createSession({
    history: rolledBackHistory,
    nativeRef: derivedNativeRef,
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    permissionMode,
    cwd: input.cwd,
    environment: sessionEnvironment,
  });

  return { ok: true, value: session };
}
