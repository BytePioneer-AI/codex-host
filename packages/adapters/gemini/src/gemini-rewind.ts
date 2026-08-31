import path from "node:path";

import type { HarnessError, HarnessResult, HostThreadSnapshot } from "@codexhost/harness-adapter";
import {
  nativeSessionRefSchema,
  type HarnessId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import type { GeminiNativeSessionLocation, GeminiTransportEvent } from "./acp-transport.js";
import { isGeminiMethodNotFound } from "./gemini-fork.js";
import { mapGeminiReplay, resolveGeminiLastTurnPromptIndex } from "./gemini-history.js";

export const GEMINI_REWIND_EXECUTE_METHOD = "_x.ai/rewind/execute";
export const GEMINI_REWIND_POINTS_METHOD = "_x.ai/rewind/points";

export interface GeminiRewindParams {
  sessionId: string;
  targetPromptIndex: number;
  force: true;
  mode: "conversation_only";
}

export interface GeminiRewindResponse {
  success: boolean;
  targetPromptIndex: number;
  mode?: string;
  promptText?: string;
  error?: string | null;
}

export interface GeminiRewindInput {
  cwd: string;
  harnessId: HarnessId;
  locateSource(sessionId: string): Promise<GeminiNativeSessionLocation | null>;
  readHistory(cwd: string, sessionId: string): Promise<GeminiTransportEvent[]>;
  rewindAndLoad(params: GeminiRewindParams): Promise<{ sessionId: string }>;
  sourceRef: NativeSessionRef;
}

function error(code: HarnessError["code"], message: string, retryable = false): HarnessError {
  return { code, message, retryable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildGeminiRewindParams(input: {
  sessionId: string;
  targetPromptIndex: number;
}): GeminiRewindParams {
  return {
    sessionId: input.sessionId,
    targetPromptIndex: input.targetPromptIndex,
    force: true,
    mode: "conversation_only",
  };
}

export function parseGeminiRewindResponse(value: unknown): GeminiRewindResponse | null {
  if (!isRecord(value)) return null;
  const payload =
    typeof value.success !== "boolean" && isRecord(value.result) ? value.result : value;
  if (!isRecord(payload) || typeof payload.success !== "boolean") return null;
  return rewindPayload(payload);
}

function rewindPayload(payload: Record<string, unknown>): GeminiRewindResponse | null {
  const targetPromptIndex =
    typeof payload.targetPromptIndex === "number"
      ? payload.targetPromptIndex
      : typeof payload.target_prompt_index === "number"
        ? payload.target_prompt_index
        : null;
  if (targetPromptIndex === null || !Number.isInteger(targetPromptIndex) || targetPromptIndex < 0) {
    return null;
  }
  const promptText =
    typeof payload.promptText === "string"
      ? payload.promptText
      : typeof payload.prompt_text === "string"
        ? payload.prompt_text
        : undefined;
  const rewindError =
    typeof payload.error === "string" ? payload.error : payload.error === null ? null : undefined;
  return {
    success: payload.success === true,
    targetPromptIndex,
    ...(typeof payload.mode === "string" ? { mode: payload.mode } : {}),
    ...(promptText !== undefined ? { promptText } : {}),
    ...(rewindError !== undefined ? { error: rewindError } : {}),
  };
}

async function readSnapshot(
  input: Pick<GeminiRewindInput, "cwd" | "harnessId" | "readHistory">,
  sessionId: string,
): Promise<HarnessResult<HostThreadSnapshot>> {
  let history: GeminiTransportEvent[];
  try {
    history = await input.readHistory(input.cwd, sessionId);
  } catch {
    return {
      ok: false,
      error: error("nativeFailure", "Gemini Native Session history could not be read", true),
    };
  }
  try {
    return { ok: true, value: mapGeminiReplay(history, input.harnessId, sessionId, input.cwd) };
  } catch {
    return {
      ok: false,
      error: error("protocolError", "Gemini Native Session history is invalid"),
    };
  }
}

export async function rewindGeminiLastTurn(
  input: GeminiRewindInput,
): Promise<HarnessResult<{ sessionId: string }>> {
  const sourceRef = nativeSessionRefSchema.safeParse(input.sourceRef);
  if (!sourceRef.success || sourceRef.data.harnessId !== input.harnessId) {
    return {
      ok: false,
      error: error("invalidRequest", "Gemini last-Turn Rewind identity does not belong to Gemini"),
    };
  }

  const located = await input.locateSource(sourceRef.data.nativeSessionId);
  if (!located) {
    return {
      ok: false,
      error: error("sessionNotFound", "Gemini Native Session is unavailable"),
    };
  }
  const sourceCwd = path.resolve(located.cwd);
  const targetCwd = path.resolve(input.cwd);
  if (sourceCwd !== targetCwd) {
    return {
      ok: false,
      error: error("invalidRequest", "Gemini last-Turn Rewind must stay in the source cwd"),
    };
  }

  const source = await readSnapshot({ ...input, cwd: sourceCwd }, sourceRef.data.nativeSessionId);
  if (!source.ok) return source;
  const targetPromptIndex = resolveGeminiLastTurnPromptIndex(source.value);
  if (source.value.turns.length === 0 || targetPromptIndex === null) {
    return {
      ok: false,
      error: error("invalidState", "Gemini Native Session has no Turn to rewind"),
    };
  }

  let sessionId: string;
  try {
    const rewound = await input.rewindAndLoad(
      buildGeminiRewindParams({
        sessionId: sourceRef.data.nativeSessionId,
        targetPromptIndex,
      }),
    );
    if (rewound.sessionId !== sourceRef.data.nativeSessionId) {
      throw new Error("Gemini Rewind returned a different Session identity");
    }
    sessionId = rewound.sessionId;
  } catch (caught) {
    if (isGeminiMethodNotFound(caught)) {
      return {
        ok: false,
        error: error("unsupported", "Gemini ACP does not support Session Rewind"),
      };
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    return {
      ok: false,
      error: error(
        "nativeFailure",
        message.includes("Rewind") ? message : "Gemini Native Rewind failed",
        true,
      ),
    };
  }

  const derived = await readSnapshot({ ...input, cwd: targetCwd }, sessionId);
  if (!derived.ok) return derived;
  const expectedKeys = source.value.turns
    .slice(0, -1)
    .map((turn) => turn.nativeTurnRef.nativeTurnKey);
  const actualKeys = derived.value.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey);
  if (
    derived.value.turns.length !== source.value.turns.length - 1 ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    derived.value.turns.some((turn) => turn.nativeTurnRef.nativeSessionId !== sessionId)
  ) {
    return {
      ok: false,
      error: error("protocolError", "Gemini Native Rewind history is invalid"),
    };
  }

  return { ok: true, value: { sessionId } };
}
