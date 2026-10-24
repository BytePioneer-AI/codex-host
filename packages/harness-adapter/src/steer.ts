import type { HarnessError } from "./text-session.js";

/**
 * The `turn.steer` refusal of a Session without native same-Turn insertion. It takes no input,
 * so the Host stops the active Turn and starts the input as the next one instead.
 */
export function unsupportedSteer(harnessLabel: string): { ok: false; error: HarnessError } {
  return {
    ok: false,
    error: {
      code: "unsupported",
      message: `${harnessLabel} cannot steer an active Turn natively`,
      retryable: false,
    },
  };
}
