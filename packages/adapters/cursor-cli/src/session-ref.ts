import { z } from "zod";

import type { HarnessExecutionPolicy } from "@codexhost/harness-adapter";
import { harnessIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import type { NativeSessionRef } from "@codexhost/shared-contracts";

const cursorHarnessId = harnessIdSchema.parse("cursor-cli");

/** The locator carries only the policy that must survive Host restart and native derivation. */
const cursorSessionLocatorSchema = z.strictObject({
  executionPolicy: z.enum(["default", "unattended-full-access"]),
});

export function cursorNativeSessionRef(
  nativeSessionId: string,
  executionPolicy: HarnessExecutionPolicy,
): NativeSessionRef {
  return nativeSessionRefSchema.parse({
    harnessId: cursorHarnessId,
    nativeSessionId,
    locator: { executionPolicy },
    formatVersion: 1,
  });
}

/** Refs persisted before this field existed carry no policy and remain valid as `default`;
 * any other unreadable locator must fail instead of silently continuing without the policy. */
export function cursorExecutionPolicy(ref: NativeSessionRef): HarnessExecutionPolicy {
  if (ref.harnessId !== cursorHarnessId || ref.formatVersion !== 1)
    throw new Error("Invalid Cursor Native Session Ref");
  if (ref.locator === undefined) return "default";
  const locator = cursorSessionLocatorSchema.safeParse(ref.locator);
  if (!locator.success) throw new Error("Invalid Cursor Native Session locator");
  return locator.data.executionPolicy;
}
