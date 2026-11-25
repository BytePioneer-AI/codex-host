import type {
  HarnessResult,
  HarnessSession,
  RollbackLastTurnSessionInput,
} from "@codexhost/harness-adapter";
import {
  nativeConversationDbPath,
  openDerivedAntigravitySession,
  readDerivationBoundaries,
  validNativeSessionRef,
  type NativeDerivationOptions,
} from "./fork.js";
import { nativeHistoryError } from "./native-turn-boundaries.js";
import { antigravityHome } from "./usage-statistics.js";

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
  try {
    const boundaries = await readDerivationBoundaries(
      nativeConversationDbPath(
        input.sourceRef.nativeSessionId,
        antigravityHome({ ...options.adapterEnvironment, ...input.environment }),
      ),
    );
    const last = boundaries.at(-1);
    if (!last)
      return {
        ok: false,
        error: {
          code: "invalidState",
          message: "Antigravity Native Session has no Turn to roll back",
          retryable: false,
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
      { cutoff: boundaries.length === 1 ? 0 : last.idx },
    );
  } catch (error) {
    return { ok: false, error: nativeHistoryError(error) };
  }
}
