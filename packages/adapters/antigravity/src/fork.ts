import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ForkSessionInput,
  HarnessResult,
  HarnessSession,
} from "@codexhost/harness-adapter";
import {
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { AntigravityHistory, type AntigravityTurn } from "./history.js";
import type { AntigravityPermissionMode } from "./permission-modes.js";

export function nativeConversationDbPath(nativeSessionId: string, homedir = os.homedir()): string {
  return path.join(homedir, ".gemini", "antigravity-cli", "conversations", `${nativeSessionId}.db`);
}

export function nativeBrainDirPath(nativeSessionId: string, homedir = os.homedir()): string {
  return path.join(homedir, ".gemini", "antigravity-cli", "brain", nativeSessionId);
}

export async function copyNativeConversationDbIfExists(
  sourceSessionId: string,
  derivedSessionId: string,
  homedir = os.homedir(),
): Promise<boolean> {
  const sourceDb = nativeConversationDbPath(sourceSessionId, homedir);
  const targetDb = nativeConversationDbPath(derivedSessionId, homedir);
  try {
    await mkdir(path.dirname(targetDb), { recursive: true });
    await copyFile(sourceDb, targetDb);
    return true;
  } catch {
    return false;
  }
}

export async function copyNativeBrainDirIfExists(
  sourceSessionId: string,
  derivedSessionId: string,
  homedir = os.homedir(),
): Promise<boolean> {
  const sourceBrain = nativeBrainDirPath(sourceSessionId, homedir);
  const targetBrain = nativeBrainDirPath(derivedSessionId, homedir);
  try {
    await cp(sourceBrain, targetBrain, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export interface ForkAntigravitySessionOptions {
  harnessId: HarnessId;
  input: ForkSessionInput;
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

export async function forkAntigravitySession(
  options: ForkAntigravitySessionOptions,
): Promise<HarnessResult<HarnessSession>> {
  const { harnessId, input, adapterEnvironment, sourceSession, createSession } = options;

  const sourceRefParsed = nativeSessionRefSchema.safeParse(input.sourceRef);
  if (!sourceRefParsed.success || sourceRefParsed.data.harnessId !== harnessId) {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Antigravity cannot fork another Harness Session",
        retryable: false,
      },
    };
  }
  const sourceRef = sourceRefParsed.data;

  const checkpointParsed = nativeCheckpointRefSchema.safeParse(input.checkpoint);
  if (
    !checkpointParsed.success ||
    checkpointParsed.data.harnessId !== harnessId ||
    checkpointParsed.data.nativeSessionId !== sourceRef.nativeSessionId
  ) {
    return {
      ok: false,
      error: {
        code: "checkpointNotFound",
        message: "Antigravity Checkpoint does not belong to the source Native Session",
        retryable: false,
      },
    };
  }
  const checkpoint = checkpointParsed.data;

  if (sourceSession?.isActive) {
    return {
      ok: false,
      error: {
        code: "sessionBusy",
        message: "Antigravity Session cannot fork while a Turn is active",
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
  const boundaryIndex = sourceTurns.findIndex(
    (turn) =>
      turn.checkpoint?.checkpointId === checkpoint.checkpointId ||
      turn.nativeTurnRef.nativeTurnKey === checkpoint.checkpointId,
  );
  if (boundaryIndex === -1) {
    return {
      ok: false,
      error: {
        code: "checkpointNotFound",
        message: `Antigravity Checkpoint '${checkpoint.checkpointId}' not found in source Session history`,
        retryable: false,
      },
    };
  }

  const retainedTurns = sourceTurns.slice(0, boundaryIndex + 1);
  const derivedNativeSessionId = randomUUID();
  const copiedTurns: AntigravityTurn[] = retainedTurns.map((turn) => ({
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

  const forkedHistory = await AntigravityHistory.createDerived({
    environment: sessionEnvironment,
    nativeSessionId: derivedNativeSessionId,
    turns: copiedTurns,
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  });

  await Promise.all([
    copyNativeConversationDbIfExists(sourceRef.nativeSessionId, derivedNativeSessionId),
    copyNativeBrainDirIfExists(sourceRef.nativeSessionId, derivedNativeSessionId),
  ]);

  const derivedNativeRef: NativeSessionRef = {
    harnessId,
    nativeSessionId: derivedNativeSessionId,
    formatVersion: 1,
  };

  const session = createSession({
    history: forkedHistory,
    nativeRef: derivedNativeRef,
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    permissionMode,
    cwd: input.cwd,
    environment: sessionEnvironment,
  });

  return { ok: true, value: session };
}
