import type {
  HarnessAdapter,
  HarnessResult,
  HarnessSession,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { DELEGATION_THREAD_ID_ENV } from "./delegation-types.js";

/** Generate Thread-scoped credentials only for a target that can actually install them.
 * Explicit caller overrides are never filtered: the Adapter must apply or reject those. */
export async function openHarnessSession(
  adapter: HarnessAdapter,
  input: OpenSessionInput,
  environment: NodeJS.ProcessEnv,
  threadId: string,
): Promise<HarnessResult<HarnessSession>> {
  if (input.environment !== undefined) return adapter.open(input);
  let scope: "session" | "native";
  try {
    scope = (await adapter.sessionEnvironmentScope?.(input)) ?? "session";
  } catch {
    return {
      ok: false,
      error: {
        code: "unavailable",
        message: "Could not determine the Harness Session environment scope",
        retryable: false,
      },
    };
  }
  if (scope === "native") return adapter.open(input);
  if (scope !== "session")
    return {
      ok: false,
      error: {
        code: "protocolError",
        message: "Invalid Harness Session environment scope",
        retryable: false,
      },
    };
  return adapter.open({
    ...input,
    environment: { ...environment, [DELEGATION_THREAD_ID_ENV]: threadId },
  });
}
