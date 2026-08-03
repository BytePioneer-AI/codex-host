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
  type NativeCheckpointRef,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { mapClaudeSnapshot } from "./claude-history.js";
import type { ClaudeAdapterDependencies } from "./transport.js";

interface ClaudeForkInput {
  checkpoint: NativeCheckpointRef;
  cwd: string;
  dependencies: Pick<
    ClaudeAdapterDependencies,
    "deleteSession" | "forkSession" | "getSessionInfo" | "readSessionMessages"
  >;
  harnessId: HarnessId;
  sourceRef: NativeSessionRef;
}

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
): Promise<HarnessResult<{ sessionId: string }>> {
  const sourceRef = nativeSessionRefSchema.safeParse(input.sourceRef);
  const checkpoint = nativeCheckpointRefSchema.safeParse(input.checkpoint);
  if (
    !sourceRef.success ||
    !checkpoint.success ||
    sourceRef.data.harnessId !== input.harnessId ||
    checkpoint.data.harnessId !== input.harnessId ||
    checkpoint.data.nativeSessionId !== sourceRef.data.nativeSessionId
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
  const boundaryIndex = source.value.turns.findIndex(
    (turn) => turn.checkpoint?.checkpointId === checkpoint.data.checkpointId,
  );
  if (boundaryIndex < 0) {
    return {
      ok: false,
      error: error("checkpointNotFound", "Claude Code Fork Checkpoint is unavailable", false),
    };
  }

  let derivedSessionId: string;
  try {
    const forked = await input.dependencies.forkSession({
      checkpointId: checkpoint.data.checkpointId,
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
    !isDeepStrictEqual(sourceAfter.value.turns.slice(0, boundaryIndex + 1), sourcePrefix) ||
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
