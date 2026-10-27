import {
  harnessIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

export const copilotId = harnessIdSchema.parse("copilot");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export class CopilotReferenceError extends Error {}

export function sessionRef(sessionId: string, unattended = false): NativeSessionRef {
  if (!uuid.test(sessionId)) throw new Error("Invalid Copilot session identity");
  return nativeSessionRefSchema.parse({
    harnessId: copilotId,
    nativeSessionId: sessionId,
    formatVersion: 1,
    locator: {
      storage: "copilot-cli",
      version: 1,
      ...(unattended ? { executionPolicy: "unattended-full-access" } : {}),
    },
  });
}

export function sessionIdFromRef(value: NativeSessionRef): string {
  const result = nativeSessionRefSchema.safeParse(value);
  if (!result.success || !uuid.test(result.data.nativeSessionId))
    throw new CopilotReferenceError("Invalid Copilot session reference");
  const parsed = result.data;
  const expected = sessionRef(parsed.nativeSessionId, sessionIsUnattended(parsed));
  if (
    parsed.harnessId !== copilotId ||
    !parsed.locator ||
    typeof parsed.locator !== "object" ||
    Array.isArray(parsed.locator) ||
    Object.keys(parsed.locator).length !== Object.keys(expected.locator ?? {}).length ||
    parsed.locator.storage !== "copilot-cli" ||
    parsed.locator.version !== 1 ||
    ("executionPolicy" in parsed.locator &&
      parsed.locator.executionPolicy !== "unattended-full-access")
  )
    throw new CopilotReferenceError("Invalid Copilot session reference");
  return parsed.nativeSessionId;
}

export function sessionIsUnattended(ref: NativeSessionRef): boolean {
  return (
    !!ref.locator &&
    typeof ref.locator === "object" &&
    !Array.isArray(ref.locator) &&
    ref.locator.executionPolicy === "unattended-full-access"
  );
}

export function turnRef(sessionId: string, messageId: string) {
  return nativeTurnRefSchema.parse({
    harnessId: copilotId,
    nativeSessionId: sessionId,
    nativeTurnKey: messageId,
    formatVersion: 1,
  });
}

export function checkpoint(sessionId: string, messageId: string) {
  return nativeCheckpointRefSchema.parse({
    harnessId: copilotId,
    nativeSessionId: sessionId,
    checkpointId: messageId,
    formatVersion: 1,
  });
}
