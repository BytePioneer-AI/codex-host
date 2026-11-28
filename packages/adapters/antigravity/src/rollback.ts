import type {
  HarnessResult,
  HarnessSession,
  RollbackLastTurnSessionInput,
} from "@codexhost/harness-adapter";
import {
  openDerivedAntigravitySession,
  validNativeSessionRef,
  type NativeDerivationOptions,
} from "./fork.js";

export interface RollbackAntigravityLastTurnOptions extends NativeDerivationOptions {
  input: RollbackLastTurnSessionInput;
}
export async function rollbackAntigravityLastTurn(
  options: RollbackAntigravityLastTurnOptions,
): Promise<HarnessResult<HarnessSession>> {
  const { input, harnessId } = options;
  if (!validNativeSessionRef(input.sourceRef, harnessId))
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Invalid Antigravity source Native Session",
        retryable: false,
      },
    };
  if (options.sourceSession?.isActive)
    return {
      ok: false,
      error: {
        code: "sessionBusy",
        message: "Source Session is busy",
        retryable: true,
      },
    };
  return openDerivedAntigravitySession(
    options,
    {
      kind: "resume",
      nativeRef: input.sourceRef,
      cwd: input.cwd,
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
      ...(input.permissionModeId ? { permissionModeId: input.permissionModeId } : {}),
    },
    input.sourceRef,
    { rollbackLastTurn: true },
  );
}
