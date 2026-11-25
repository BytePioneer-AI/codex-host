import {
  createDraftPrewarmPolicyBridge,
  type RendererDraftBridgePolicy,
} from "../src/renderer-draft-prewarm-runtime.js";

/** A single-connection fixture for the transport tests. Production installs
 * policies through the native Host router, not this fixture's global slot. */
export function installDraftPrewarmPolicyBridge(
  ...args: Parameters<typeof createDraftPrewarmPolicyBridge>
): { state: "ready"; reason: "owned-request-bridge" } {
  const [manager, bridge, hostId, target, prewarmed, isCurrent] = args;
  const previous = target.__codexhostDraftPrewarmPolicyV1 as RendererDraftBridgePolicy | undefined;
  if (
    previous?.owns.length !== 5 ||
    !previous.owns(manager, bridge, hostId, prewarmed, !!isCurrent)
  ) {
    previous?.dispose();
    Object.defineProperty(target, "__codexhostDraftPrewarmPolicyV1", {
      configurable: true,
      value: createDraftPrewarmPolicyBridge(...args),
    });
    if (typeof target.dispatchEvent === "function" && typeof CustomEvent === "function") {
      target.dispatchEvent(new CustomEvent("codexhost:draft-prewarm-policy-changed"));
    }
  }
  return { state: "ready", reason: "owned-request-bridge" };
}
