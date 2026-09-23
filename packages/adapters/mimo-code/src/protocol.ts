import type {
  HarnessError,
  HarnessErrorCode,
  HarnessResult,
  HarnessSessionCapabilities,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

export const MIMO_ID = harnessIdSchema.parse("mimo-code");
export const capabilities: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: false,
    selectPermissionMode: true,
    permissionModeScope: "atCreate",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  subagents: { observe: false, readTranscript: false },
  autonomousTurns: { observe: false },
};
export class MimoError extends Error {
  constructor(
    readonly code: HarnessErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export function errorOf(error: unknown): HarnessError {
  // Native errors may contain provider credentials or request bodies. Do not forward them.
  return error instanceof MimoError
    ? {
        code: error.code,
        message: error.message,
        retryable: ["unavailable", "sessionBusy"].includes(error.code),
      }
    : { code: "nativeFailure", message: "MiMo native operation failed", retryable: false };
}
export function failure<T = never>(code: HarnessErrorCode, message: string): HarnessResult<T> {
  return { ok: false, error: errorOf(new MimoError(code, message)) };
}
export function checked<T>(result: {
  data?: T;
  error?: unknown;
  response?: Response;
}): Exclude<T, undefined> {
  if (result.error !== undefined || (result.response && !result.response.ok)) {
    const status = result.response?.status;
    throw new MimoError(
      status === 401 || status === 403
        ? "authenticationRequired"
        : status === 404
          ? "sessionNotFound"
          : status === 409
            ? "sessionBusy"
            : "nativeFailure",
      "MiMo native request failed",
    );
  }
  if (result.data === undefined) throw new MimoError("protocolError", "MiMo response has no data");
  return result.data as Exclude<T, undefined>;
}
export type NativeModel = { providerID: string; modelID: string };
const MODEL_PREFIX = "mimo-model-v1.";
export function encodeModel(model: NativeModel): HarnessModelRef {
  return harnessModelRefSchema.parse({
    id:
      MODEL_PREFIX +
      Buffer.from(JSON.stringify([model.providerID, model.modelID])).toString("base64url"),
  });
}
export function decodeModel(model: HarnessModelRef): NativeModel {
  try {
    const id = harnessModelRefSchema.parse(model).id;
    if (!id.startsWith(MODEL_PREFIX)) throw new Error();
    const pair: unknown = JSON.parse(
      Buffer.from(id.slice(MODEL_PREFIX.length), "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      pair.some((v) => typeof v !== "string" || !v.trim())
    )
      throw new Error();
    const native = { providerID: pair[0] as string, modelID: pair[1] as string };
    if (encodeModel(native).id !== id) throw new Error();
    return native;
  } catch {
    throw new MimoError("invalidRequest", "Invalid MiMo Model Ref");
  }
}
export async function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MimoError("unavailable", message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
