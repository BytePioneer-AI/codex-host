import type {
  HarnessModelRef,
  HarnessThinkingOptionId,
  NativeSessionRef,
} from "@codexhost/shared-contracts";
import type { ModelSelectCommand, ThinkingSelectCommand } from "@codexhost/harness-adapter";
import type { BridgeClient } from "./bridge.js";
import type { BridgeInspection } from "./protocol.js";
import { nativeModelId, nativeThinkingSelection, modelThinkingOptions } from "./models.js";
import { record, TraeError } from "./errors.js";
import { sameDirectory } from "./discovery.js";
import { validateReference } from "./reference.js";

/** Desktop itself supplies model DTOs per send; this prepares the next request. */
export async function prepareModelSelection(
  client: BridgeClient,
  inspection: BridgeInspection,
  model: HarnessModelRef,
  sessionId?: string,
  thinkingOptionId?: HarnessThinkingOptionId,
): Promise<void> {
  if (inspection.configuration?.modelSelection !== "per-request")
    throw new TraeError(
      "unsupported",
      "Update the TRAE CN Companion to select a model for the next request",
    );
  const id = nativeModelId(inspection, model);
  const thinking = thinkingOptionId
    ? nativeThinkingSelection(inspection, model, thinkingOptionId)
    : undefined;
  const receipt = await client.call("prepareModel", {
    modelId: id,
    ...(sessionId ? { sessionId } : {}),
    ...(thinking ? { thinking } : {}),
  });
  if (
    !record(receipt) ||
    receipt.agentType !== inspection.agentType ||
    receipt.modelId !== id ||
    (thinking
      ? !record(receipt.thinking) ||
        receipt.thinking.field !== thinking.field ||
        receipt.thinking.level !== thinking.level
      : receipt.thinking !== undefined)
  )
    throw new TraeError(
      "protocolError",
      "TRAE CN did not confirm the prepared model configuration",
    );
}

export async function prepareSelectionChange(input: {
  client: BridgeClient;
  cwd: string;
  nativeRef: NativeSessionRef | undefined;
  currentModel: HarnessModelRef | undefined;
  currentThinking: HarnessThinkingOptionId | undefined;
  command: ModelSelectCommand | ThinkingSelectCommand;
}) {
  const model = input.command.type === "model.select" ? input.command.model : input.currentModel;
  if (!model)
    throw new TraeError("configurationRequired", "Choose a native model before selecting Thinking");
  const inspection = await input.client.inspect(true);
  if (input.nativeRef) validateReference(input.nativeRef, inspection, input.cwd);
  if (!inspection.workspaceFolders.some((folder) => sameDirectory(folder, input.cwd)))
    throw new TraeError("configurationRequired", "The TRAE CN workspace changed");
  const availableThinkingOptions = modelThinkingOptions(inspection, model);
  const thinking =
    input.command.type === "thinking.select"
      ? input.command.thinkingOptionId
      : model.id === input.currentModel?.id &&
          availableThinkingOptions.some((option) => option.id === input.currentThinking)
        ? input.currentThinking
        : undefined;
  await prepareModelSelection(
    input.client,
    inspection,
    model,
    input.nativeRef?.nativeSessionId,
    thinking,
  );
  return { inspection, model, thinking, availableThinkingOptions };
}
