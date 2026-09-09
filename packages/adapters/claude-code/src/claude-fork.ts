import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  HarnessError,
  HarnessResult,
  HostThreadSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type HarnessConfigurationState,
  type NativeCheckpointRef,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { mapClaudeSnapshot } from "./claude-history.js";
import type { ClaudePendingSessions } from "./pending-session.js";
import type { ClaudeAdapterDependencies } from "./transport.js";

interface ClaudeForkBase {
  cwd: string;
  dependencies: Pick<
    ClaudeAdapterDependencies,
    "deleteSession" | "forkSession" | "getSessionInfo" | "readSessionMessages"
  >;
  harnessId: HarnessId;
  sourceRef: NativeSessionRef;
}

type ClaudeForkInput = ClaudeForkBase &
  (
    | { kind: "fork"; checkpoint: NativeCheckpointRef }
    | {
        kind: "rollbackLastTurn";
        pendingSessions: ClaudePendingSessions;
        configuration: HarnessConfigurationState;
      }
  );

function error(code: HarnessError["code"], message: string, retryable: boolean): HarnessError {
  return { code, message, retryable };
}

function comparableTurn(turn: HostTurnSnapshot): unknown {
  return {
    input: turn.input,
    items: turn.items.map(({ item, outcome }) => ({
      item: { ...item, itemId: undefined },
      outcome,
    })),
    outcome: turn.outcome,
    hasCheckpoint: turn.checkpoint !== undefined,
    ...(turn.model ? { model: turn.model } : {}),
  };
}

function nativeIds(snapshot: HostThreadSnapshot): Set<string> {
  return new Set(
    snapshot.turns.flatMap((turn) => [
      turn.nativeTurnRef.nativeTurnKey,
      ...(turn.checkpoint ? [turn.checkpoint.checkpointId] : []),
    ]),
  );
}

async function readSnapshot(
  dependencies: ClaudeForkInput["dependencies"],
  cwd: string,
  sessionId: string,
): Promise<HarnessResult<HostThreadSnapshot>> {
  let messages: unknown[];
  try {
    messages = await dependencies.readSessionMessages({ cwd, sessionId });
  } catch {
    return {
      ok: false,
      error: error("nativeFailure", "Claude Code history could not be read", true),
    };
  }
  if (messages.length === 0) {
    return {
      ok: false,
      error: error("sessionNotFound", "Claude Code Native Session is unavailable", false),
    };
  }
  try {
    return { ok: true, value: mapClaudeSnapshot(messages, sessionId) };
  } catch {
    return {
      ok: false,
      error: error("protocolError", "Claude Code history is invalid", false),
    };
  }
}

export async function forkClaudeSession(
  input: ClaudeForkInput,
): Promise<
  HarnessResult<{ sessionId: string; nativeRef?: NativeSessionRef; openMode?: "create" }>
> {
  const sourceRef = nativeSessionRefSchema.safeParse(input.sourceRef);
  const checkpoint =
    input.kind === "fork" ? nativeCheckpointRefSchema.safeParse(input.checkpoint) : null;
  if (
    !sourceRef.success ||
    sourceRef.data.harnessId !== input.harnessId ||
    (checkpoint &&
      (!checkpoint.success ||
        checkpoint.data.harnessId !== input.harnessId ||
        checkpoint.data.nativeSessionId !== sourceRef.data.nativeSessionId))
  ) {
    return {
      ok: false,
      error: error(
        "invalidRequest",
        "Claude Code Fork identity does not belong to the source Session",
        false,
      ),
    };
  }

  let sourceInfo: { cwd?: string } | undefined;
  try {
    sourceInfo = await input.dependencies.getSessionInfo({
      sessionId: sourceRef.data.nativeSessionId,
    });
  } catch {
    return {
      ok: false,
      error: error("nativeFailure", "Claude Code Session metadata could not be read", true),
    };
  }
  if (!sourceInfo) {
    return {
      ok: false,
      error: error("sessionNotFound", "Claude Code Native Session is unavailable", false),
    };
  }
  if (!sourceInfo.cwd) {
    return {
      ok: false,
      error: error("protocolError", "Claude Code Session working directory is unavailable", false),
    };
  }
  if (path.resolve(sourceInfo.cwd) !== input.cwd) {
    return {
      ok: false,
      error: error("unsupported", "Claude Code cannot Fork across working directories", false),
    };
  }

  const source = await readSnapshot(input.dependencies, input.cwd, sourceRef.data.nativeSessionId);
  if (!source.ok) return source;
  if (input.kind === "rollbackLastTurn" && source.value.turns.length === 0) {
    return {
      ok: false,
      error: error("invalidRequest", "Claude Code Session has no Turn to roll back", false),
    };
  }
  if (input.kind === "rollbackLastTurn" && source.value.turns.length === 1) {
    let nativeRef: NativeSessionRef;
    try {
      nativeRef = await input.pendingSessions.create(input.cwd, input.configuration);
    } catch {
      return {
        ok: false,
        error: error("nativeFailure", "Claude Code empty rollback could not be persisted", true),
      };
    }
    const sourceAfter = await readSnapshot(
      input.dependencies,
      input.cwd,
      sourceRef.data.nativeSessionId,
    );
    if (!sourceAfter.ok || !isDeepStrictEqual(sourceAfter.value, source.value)) {
      await input.pendingSessions.discard(nativeRef, input.cwd).catch(() => undefined);
      return {
        ok: false,
        error: error("protocolError", "Claude Code source history changed during rollback", false),
      };
    }
    return {
      ok: true,
      value: { sessionId: nativeRef.nativeSessionId, nativeRef, openMode: "create" },
    };
  }
  const boundaryIndex =
    input.kind === "rollbackLastTurn"
      ? source.value.turns.length - 2
      : source.value.turns.findIndex(
          (turn) =>
            checkpoint?.success && turn.checkpoint?.checkpointId === checkpoint.data.checkpointId,
        );
  const retained = source.value.turns[boundaryIndex];
  const boundaryId =
    retained?.checkpoint?.checkpointId ??
    (input.kind === "rollbackLastTurn" ? retained?.nativeTurnRef.nativeTurnKey : undefined);
  if (boundaryIndex < 0 || !boundaryId) {
    return {
      ok: false,
      error: error("checkpointNotFound", "Claude Code Fork Checkpoint is unavailable", false),
    };
  }

  let derivedSessionId: string;
  try {
    const forked = await input.dependencies.forkSession({
      checkpointId: boundaryId,
      cwd: input.cwd,
      sourceSessionId: sourceRef.data.nativeSessionId,
    });
    const derivedRef = nativeSessionRefSchema.safeParse({
      harnessId: input.harnessId,
      nativeSessionId: forked.sessionId,
      formatVersion: 1,
    });
    if (!derivedRef.success || derivedRef.data.nativeSessionId === sourceRef.data.nativeSessionId) {
      throw new Error("Claude Code Fork returned an invalid Session identity");
    }
    derivedSessionId = derivedRef.data.nativeSessionId;
  } catch {
    return {
      ok: false,
      error: error("nativeFailure", "Claude Code Native Fork failed", true),
    };
  }

  const cleanup = async (): Promise<void> => {
    await input.dependencies
      .deleteSession({ cwd: input.cwd, sessionId: derivedSessionId })
      .catch(() => undefined);
  };
  const [derived, sourceAfter] = await Promise.all([
    readSnapshot(input.dependencies, input.cwd, derivedSessionId),
    readSnapshot(input.dependencies, input.cwd, sourceRef.data.nativeSessionId),
  ]);
  if (!derived.ok) {
    await cleanup();
    return { ok: false, error: derived.error };
  }
  if (!sourceAfter.ok) {
    await cleanup();
    return { ok: false, error: sourceAfter.error };
  }

  const sourcePrefix = source.value.turns.slice(0, boundaryIndex + 1);
  const expectedPrefix = sourcePrefix.map(comparableTurn);
  const derivedContent = derived.value.turns.map(comparableTurn);
  const sourceIds = nativeIds(source.value);
  const derivedIds = nativeIds(derived.value);
  if (
    (input.kind === "rollbackLastTurn" &&
      sourceAfter.value.turns.length !== source.value.turns.length) ||
    sourceAfter.value.turns.length < source.value.turns.length ||
    !isDeepStrictEqual(
      sourceAfter.value.turns.slice(0, source.value.turns.length),
      source.value.turns,
    ) ||
    !isDeepStrictEqual(derivedContent, expectedPrefix) ||
    derivedIds.size === 0 ||
    [...derivedIds].some((id) => sourceIds.has(id))
  ) {
    await cleanup();
    return {
      ok: false,
      error: error("protocolError", "Claude Code Native Fork history is invalid", false),
    };
  }

  return { ok: true, value: { sessionId: derivedSessionId } };
}
