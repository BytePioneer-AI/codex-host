import { isDeepStrictEqual } from "node:util";

import type { HarnessError, HarnessResult, HostThreadSnapshot } from "@codexhost/harness-adapter";
import {
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type NativeCheckpointRef,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import path from "node:path";

import type { GrokNativeSessionLocation, GrokTransportEvent } from "./acp-transport.js";
import { mapGrokReplay, resolveGrokTargetPromptIndex } from "./grok-history.js";

export const GROK_SESSION_FORK_METHOD = "_x.ai/session/fork";
export const GROK_SESSION_DELETE_METHOD = "_x.ai/session/delete";

export interface GrokForkParams {
  sourceSessionId: string;
  sourceCwd: string;
  newCwd: string;
  targetPromptIndex: number;
  newSessionId?: string;
  newModelId?: string;
  sessionKind?: string;
  sourceWorkspaceDir?: string;
}

export interface GrokForkResponse {
  newSessionId: string;
  parentSessionId?: string;
  newCwd?: string;
  chatMessagesCopied?: number;
  updatesCopied?: number;
  planStateCopied?: boolean;
  newModelId?: string;
}

export interface GrokForkInput {
  checkpoint: NativeCheckpointRef;
  cwd: string;
  harnessId: HarnessId;
  locateSource(sessionId: string): Promise<GrokNativeSessionLocation | null>;
  readHistory(cwd: string, sessionId: string): Promise<GrokTransportEvent[]>;
  sourceRef: NativeSessionRef;
  forkAndLoad(params: GrokForkParams): Promise<{ sessionId: string }>;
  deleteSession(cwd: string, sessionId: string): Promise<void>;
}

function error(code: HarnessError["code"], message: string, retryable = false): HarnessError {
  return { code, message, retryable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isGrokMethodNotFound(error: unknown): boolean {
  if (isRecord(error) && error.code === -32601) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /method not found/iu.test(message);
}

export function buildGrokForkParams(input: GrokForkParams): GrokForkParams {
  return {
    sourceSessionId: input.sourceSessionId,
    sourceCwd: input.sourceCwd,
    newCwd: input.newCwd,
    targetPromptIndex: input.targetPromptIndex,
    ...(input.newSessionId ? { newSessionId: input.newSessionId } : {}),
    ...(input.newModelId ? { newModelId: input.newModelId } : {}),
    ...(input.sessionKind ? { sessionKind: input.sessionKind } : {}),
    ...(input.sourceWorkspaceDir ? { sourceWorkspaceDir: input.sourceWorkspaceDir } : {}),
  };
}

export function parseGrokForkResponse(value: unknown): GrokForkResponse | null {
  if (!isRecord(value) || value.error !== undefined) return null;
  const payload =
    typeof value.newSessionId !== "string" && isRecord(value.result) ? value.result : value;
  if (!isRecord(payload) || payload.error !== undefined) return null;
  if (typeof payload.newSessionId !== "string" || payload.newSessionId.length === 0) return null;
  return {
    newSessionId: payload.newSessionId,
    ...(typeof payload.parentSessionId === "string"
      ? { parentSessionId: payload.parentSessionId }
      : {}),
    ...(typeof payload.newCwd === "string" ? { newCwd: payload.newCwd } : {}),
    ...(typeof payload.chatMessagesCopied === "number"
      ? { chatMessagesCopied: payload.chatMessagesCopied }
      : {}),
    ...(typeof payload.updatesCopied === "number" ? { updatesCopied: payload.updatesCopied } : {}),
    ...(typeof payload.planStateCopied === "boolean"
      ? { planStateCopied: payload.planStateCopied }
      : {}),
    ...(typeof payload.newModelId === "string" ? { newModelId: payload.newModelId } : {}),
  };
}

function projectRelativePath(value: string, cwds: readonly string[]): string {
  const normalized = value.replaceAll("\\", "/");
  if (!path.isAbsolute(value)) return normalized;
  for (const cwd of cwds) {
    const relative = path.relative(path.resolve(cwd), path.resolve(value));
    if (relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
      return relative.replaceAll("\\", "/");
    }
  }
  return normalized;
}

function comparableTurn(
  turn: HostThreadSnapshot["turns"][number],
  cwds: readonly string[],
): unknown {
  return {
    input: turn.input,
    items: turn.items.map(({ item, outcome }) => ({
      item:
        item.type === "fileChange"
          ? {
              ...item,
              itemId: undefined,
              changes: item.changes.map((change) => ({
                ...change,
                path: projectRelativePath(change.path, cwds),
              })),
            }
          : { ...item, itemId: undefined },
      outcome,
    })),
    outcome: turn.outcome,
    ...(turn.model ? { model: turn.model } : {}),
  };
}

async function readSnapshot(
  input: Pick<GrokForkInput, "cwd" | "harnessId" | "readHistory">,
  sessionId: string,
): Promise<HarnessResult<HostThreadSnapshot>> {
  let history: GrokTransportEvent[];
  try {
    history = await input.readHistory(input.cwd, sessionId);
  } catch {
    return {
      ok: false,
      error: error("nativeFailure", "Grok Native Session history could not be read", true),
    };
  }
  if (history.length === 0) {
    return {
      ok: false,
      error: error("sessionNotFound", "Grok Native Session history is unavailable"),
    };
  }
  try {
    return { ok: true, value: mapGrokReplay(history, input.harnessId, sessionId, input.cwd) };
  } catch {
    return {
      ok: false,
      error: error("protocolError", "Grok Native Session history is invalid"),
    };
  }
}

export async function forkGrokSession(
  input: GrokForkInput,
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
      error: error("invalidRequest", "Grok Fork identity does not belong to the source Session"),
    };
  }

  const located = await input.locateSource(sourceRef.data.nativeSessionId);
  if (!located) {
    return {
      ok: false,
      error: error("sessionNotFound", "Grok Native Session is unavailable"),
    };
  }
  const sourceCwd = path.resolve(located.cwd);
  const targetCwd = path.resolve(input.cwd);
  const source = await readSnapshot({ ...input, cwd: sourceCwd }, sourceRef.data.nativeSessionId);
  if (!source.ok) return source;
  const boundaryIndex = source.value.turns.findIndex(
    (turn) => turn.checkpoint?.checkpointId === checkpoint.data.checkpointId,
  );
  const targetPromptIndex = resolveGrokTargetPromptIndex(
    source.value,
    checkpoint.data.checkpointId,
  );
  if (boundaryIndex < 0 || targetPromptIndex === null) {
    return {
      ok: false,
      error: error("checkpointNotFound", "Grok Fork Checkpoint is unavailable"),
    };
  }

  const sameCwd = sourceCwd === targetCwd;
  let derivedSessionId: string;
  try {
    const forked = await input.forkAndLoad(
      buildGrokForkParams({
        sourceSessionId: sourceRef.data.nativeSessionId,
        sourceCwd,
        newCwd: targetCwd,
        targetPromptIndex,
        sessionKind: sameCwd ? "fork" : "worktree",
        ...(!sameCwd ? { sourceWorkspaceDir: located.sourceWorkspaceDir ?? sourceCwd } : {}),
      }),
    );
    const derivedRef = nativeSessionRefSchema.safeParse({
      harnessId: input.harnessId,
      nativeSessionId: forked.sessionId,
      formatVersion: 1,
    });
    if (!derivedRef.success || derivedRef.data.nativeSessionId === sourceRef.data.nativeSessionId) {
      throw new Error("Grok Fork returned an invalid Session identity");
    }
    derivedSessionId = derivedRef.data.nativeSessionId;
  } catch (caught) {
    if (isGrokMethodNotFound(caught)) {
      return {
        ok: false,
        error: error("unsupported", "Grok ACP does not support Session Fork"),
      };
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    return {
      ok: false,
      error: error(
        "nativeFailure",
        message.includes("session/load failed") ? message : "Grok Native Fork failed",
        true,
      ),
    };
  }

  const cleanup = async (): Promise<void> => {
    await input.deleteSession(targetCwd, derivedSessionId).catch(() => undefined);
  };
  const [derived, sourceAfter] = await Promise.all([
    readSnapshot({ ...input, cwd: targetCwd }, derivedSessionId),
    readSnapshot({ ...input, cwd: sourceCwd }, sourceRef.data.nativeSessionId),
  ]);
  if (!derived.ok) {
    await cleanup();
    return derived;
  }
  if (!sourceAfter.ok) {
    await cleanup();
    return sourceAfter;
  }

  const compareCwds = [sourceCwd, targetCwd];
  const sourcePrefix = source.value.turns.slice(0, boundaryIndex + 1);
  if (
    !isDeepStrictEqual(
      sourceAfter.value.turns
        .slice(0, boundaryIndex + 1)
        .map((turn) => comparableTurn(turn, compareCwds)),
      sourcePrefix.map((turn) => comparableTurn(turn, compareCwds)),
    ) ||
    !isDeepStrictEqual(
      derived.value.turns.map((turn) => comparableTurn(turn, compareCwds)),
      sourcePrefix.map((turn) => comparableTurn(turn, compareCwds)),
    ) ||
    derived.value.turns.length === 0 ||
    derived.value.turns.some(
      (turn) =>
        turn.nativeTurnRef.nativeSessionId !== derivedSessionId ||
        turn.checkpoint?.nativeSessionId !== derivedSessionId,
    )
  ) {
    await cleanup();
    return {
      ok: false,
      error: error("protocolError", "Grok Native Fork history is invalid"),
    };
  }

  return { ok: true, value: { sessionId: derivedSessionId } };
}
