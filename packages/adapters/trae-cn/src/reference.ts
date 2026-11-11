import { nativeSessionRefSchema, type NativeSessionRef } from "@codexhost/shared-contracts";
import type { BridgeInspection } from "./protocol.js";
import { record, TraeError } from "./errors.js";
import { sameDirectory } from "./discovery.js";

export function validateReference(
  reference: NativeSessionRef,
  inspection: BridgeInspection,
  cwd: string,
): void {
  const parsed = nativeSessionRefSchema.safeParse(reference);
  const locator = parsed.success ? parsed.data.locator : undefined;
  if (
    !parsed.success ||
    parsed.data.harnessId !== "trae-cn" ||
    !record(locator) ||
    typeof locator.applicationRoot !== "string" ||
    !sameDirectory(locator.applicationRoot, inspection.application.root) ||
    typeof locator.cwd !== "string" ||
    !sameDirectory(locator.cwd, cwd) ||
    typeof locator.agentType !== "string" ||
    !["builder_v3", "solo_agent"].includes(locator.agentType) ||
    typeof locator.projectId !== "string" ||
    !locator.projectId
  )
    throw new TraeError(
      "invalidRequest",
      "TRAE CN reference belongs to a different application, Agent or workspace",
    );
  if (locator.agentType !== inspection.agentType)
    throw new TraeError(
      "configurationRequired",
      `This Session requires native ${locator.agentType}. Select its original Agent in the TRAE CN Companion settings and restart the Bridge after finishing active work`,
    );
}
