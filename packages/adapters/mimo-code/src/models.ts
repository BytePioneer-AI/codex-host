import type { OpencodeClient } from "@mimo-ai/sdk/v2/client";
import type { HarnessModelRef } from "@codexhost/shared-contracts";
import { checked, decodeModel, MimoError } from "./protocol.js";

/** Selection configures the model argument of subsequent native prompts. */
export async function validateModel(client: OpencodeClient, model: HarnessModelRef): Promise<void> {
  const native = decodeModel(model);
  const providers = checked(await client.provider.list());
  if (
    !providers.connected.includes(native.providerID) ||
    !providers.all.some(
      (provider) =>
        provider.id === native.providerID &&
        Object.values(provider.models).some((entry) => entry.id === native.modelID),
    )
  )
    throw new MimoError("invalidRequest", "MiMo Model is absent from the connected native catalog");
}
