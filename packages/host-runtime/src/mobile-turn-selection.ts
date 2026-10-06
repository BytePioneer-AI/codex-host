import { harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";
import {
  decodeCreateRoute,
  encodeExternalTransportSelection,
  type JsonObject,
} from "@codexhost/protocol-core";
import {
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import type { ExternalThread } from "./external-thread-runtime.js";
import { object } from "./shared-thread-peer.js";

/** Runs inside the owner's per-Thread request queue, before admitting any input. */
export async function applyMobileTurnSelection(
  thread: ExternalThread,
  params: JsonObject,
  repository: ExternalThreadRepository,
): Promise<void> {
  if (params.serviceTier != null)
    throw new Error("This Harness does not support Codex service tiers");
  const collaboration = object(params.collaborationMode) ? params.collaborationMode : undefined;
  if (collaboration && collaboration.mode !== "default")
    throw new Error("This Harness does not support Codex collaboration modes");
  const settings =
    collaboration && object(collaboration.settings) ? collaboration.settings : undefined;
  if (settings?.developer_instructions != null)
    throw new Error("This Harness does not support collaboration developer instructions");
  const carrier = params.model ?? settings?.model;
  if (params.model != null && settings?.model != null && params.model !== settings.model)
    throw new Error("Conflicting mobile Model selections");
  const route =
    typeof carrier === "string"
      ? decodeCreateRoute({ id: 0, method: "thread/start", params: { model: carrier } })
      : undefined;
  if (carrier != null && (!route || route.harnessId !== thread.harnessId))
    throw new Error("Choose a Model belonging to this Thread's Harness");
  const effort = params.effort ?? settings?.reasoning_effort;
  if (
    params.effort != null &&
    settings?.reasoning_effort != null &&
    params.effort !== settings.reasoning_effort
  )
    throw new Error("Conflicting mobile thinking selections");
  if (effort != null && typeof effort !== "string") throw new Error("Invalid thinking selection");
  try {
    if (route?.model && route.model.id !== thread.stateObserver.state.effectiveModel?.id) {
      if (!thread.session.capabilities.configuration.selectModel)
        throw new Error("This Harness cannot change Model in an existing Thread");
      const revision = thread.stateObserver.revision;
      const selected = await thread.session.execute({ type: "model.select", model: route.model });
      if (!selected.ok) throw new Error(selected.error.message);
      const state = await thread.stateObserver.waitForChange(revision);
      if (state.effectiveModel?.id !== route.model.id)
        throw new Error("Harness did not confirm the requested Model; message was not sent");
    }
    const state = thread.stateObserver.state;
    // "none" represents the default for catalogs with no selectable thinking options.
    if (
      typeof effort === "string" &&
      effort !== state.effectiveThinkingOptionId &&
      !(effort === "none" && !state.availableThinkingOptions?.length)
    ) {
      if (
        !thread.session.capabilities.configuration.selectThinkingOption ||
        !state.availableThinkingOptions?.some((option) => option.id === effort)
      )
        throw new Error("This Harness Model does not support the selected thinking option");
      const revision = thread.stateObserver.revision;
      const selected = await thread.session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse(effort),
      });
      if (!selected.ok) throw new Error(selected.error.message);
      const confirmed = await thread.stateObserver.waitForChange(revision);
      if (confirmed.effectiveThinkingOptionId !== effort)
        throw new Error(
          "Harness did not confirm the requested thinking option; message was not sent",
        );
    }
  } finally {
    // Native selections are sequential, not transactional. Persist confirmed state even
    // if a later selection fails; no input is admitted until this write succeeds.
    await persistConfirmedSelection(thread, repository);
  }
}

async function persistConfirmedSelection(
  thread: ExternalThread,
  repository: ExternalThreadRepository,
): Promise<void> {
  const confirmed = thread.stateObserver.state;
  if (confirmed.effectiveModel) {
    const transportModelId = encodeExternalTransportSelection(thread.harnessId, {
      model: confirmed.effectiveModel,
      ...(confirmed.effectiveThinkingOptionId
        ? { thinkingOptionId: confirmed.effectiveThinkingOptionId }
        : {}),
      ...(confirmed.effectivePermissionModeId
        ? { permissionModeId: confirmed.effectivePermissionModeId }
        : {}),
    });
    if (transportModelId !== thread.transportModelId) {
      thread.record = await repository.setTransportModelId(
        thread.record.hostThreadId,
        transportModelId,
      );
    }
    thread.transportModelId = transportModelId;
    thread.requestedModel = confirmed.effectiveModel;
    if (confirmed.effectiveThinkingOptionId)
      thread.requestedThinkingOptionId = confirmed.effectiveThinkingOptionId;
    else delete thread.requestedThinkingOptionId;
    thread.thread = externalThreadValue({
      record: thread.record,
      turns: thread.turns,
      sessionId: thread.sessionId,
      running: thread.running,
    });
  }
}
