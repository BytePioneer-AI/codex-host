import type { HarnessModelRef } from "@codexhost/shared-contracts";
import type { BridgeClient } from "./bridge.js";
import type { BridgeInspection } from "./protocol.js";
import { nativeModelId } from "./models.js";
import { record, TraeError } from "./errors.js";

/** Desktop itself supplies model DTOs per send; this prepares the next request. */
export async function prepareModelSelection(
  client: BridgeClient,
  inspection: BridgeInspection,
  model: HarnessModelRef,
  sessionId?: string,
): Promise<void> {
  if (inspection.configuration?.modelSelection !== "per-request")
    throw new TraeError(
      "unsupported",
      "Update the TRAE CN Companion to select a model for the next request",
    );
  const id = nativeModelId(inspection, model);
  const receipt = await client.call("prepareModel", {
    modelId: id,
    ...(sessionId ? { sessionId } : {}),
  });
  if (!record(receipt) || receipt.agentType !== inspection.agentType || receipt.modelId !== id)
    throw new TraeError(
      "protocolError",
      "TRAE CN did not confirm the prepared model configuration",
    );
}
