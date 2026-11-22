import type { HarnessAdapter } from "@codexhost/harness-adapter";
import { normalizeStoredModelRef } from "./stored-model-ref.js";
import type { RoutedHarnessId } from "@codexhost/protocol-core";
import {
  catalogModelForRef,
  sameHarnessModelRef,
  type HarnessDelegationDefault,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

import { formatDelegationModel } from "./delegation-model-argument.js";
import { DelegationControlError, type HarnessInspectResult } from "./delegation-types.js";

export async function resolveDelegationConfiguration(input: {
  harnessId: RoutedHarnessId;
  adapter?: HarnessAdapter | undefined;
  explicit: HarnessDelegationDefault;
  readDefault: () => Promise<HarnessDelegationDefault | undefined>;
  inspect: () => Promise<HarnessInspectResult>;
}): Promise<{ model?: HarnessModelRef; thinkingOptionId?: HarnessThinkingOptionId }> {
  const official = input.harnessId === "codex";
  const { model: explicitModel, thinkingOptionId: explicitThinking } = input.explicit;
  const saved =
    explicitModel && explicitThinking
      ? undefined
      : await input.readDefault().catch(() => undefined);
  if (!explicitModel && !explicitThinking && !saved?.model && !saved?.thinkingOptionId) return {};

  const inspected = await input.inspect().catch((error: unknown) => {
    if (explicitModel || explicitThinking) throw error;
    return undefined;
  });
  if (!inspected) return {};
  const { inspection } = inspected;
  if (inspection.status !== "ready") {
    if (!explicitModel && !explicitThinking) return {};
    throw new DelegationControlError(
      "DELEGATION_FAILED",
      official ? "Official Model catalog is unavailable" : inspection.error.message,
      official ? undefined : { status: inspection.status },
    );
  }
  const {
    catalog,
    capabilities: { configuration },
  } = inspection;
  const savedModel =
    saved?.model && configuration.selectModel
      ? await normalizeStoredModelRef(saved.model, catalog, input.harnessId, input.adapter)
      : undefined;
  let model = explicitModel ?? savedModel;
  let thinkingOptionId =
    explicitThinking ??
    ((!saved?.model || savedModel) &&
    (!explicitModel || sameHarnessModelRef(explicitModel, savedModel))
      ? saved?.thinkingOptionId
      : undefined);
  if (model && (!configuration.selectModel || !catalogModelForRef(catalog, model))) {
    if (explicitModel) {
      if (!official && !configuration.selectModel) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "Harness does not support Model selection",
        );
      }
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        official ? "Official Model is unavailable" : "Model is unavailable for the target Harness",
        {
          validModelIds: catalog.models.flatMap(({ ref, fastModel }) =>
            fastModel
              ? [formatDelegationModel(ref), formatDelegationModel(fastModel)]
              : [formatDelegationModel(ref)],
          ),
        },
      );
    }
    model = undefined;
    thinkingOptionId = explicitThinking;
  }

  if (thinkingOptionId) {
    const thinkingIdsFor = (ref: HarnessModelRef | undefined) =>
      catalogModelForRef(catalog, ref ?? catalog.defaultModel)?.supportedThinkingOptionIds ?? [];
    let validThinkingOptionIds = thinkingIdsFor(model);
    // A saved model must not prevent trying an explicit Thinking option on the native default.
    if (
      model &&
      !explicitModel &&
      explicitThinking &&
      (!configuration.selectThinkingOption || !validThinkingOptionIds.includes(explicitThinking))
    ) {
      model = undefined;
      validThinkingOptionIds = thinkingIdsFor(model);
    }
    if (!configuration.selectThinkingOption || !validThinkingOptionIds.includes(thinkingOptionId)) {
      if (explicitThinking) {
        if (!official && !configuration.selectThinkingOption) {
          throw new DelegationControlError(
            "INVALID_ARGUMENT",
            "Harness does not support Thinking selection",
          );
        }
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          `${official ? "Official " : ""}Thinking option is unavailable for the selected Model`,
          { validThinkingOptionIds },
        );
      }
      thinkingOptionId = undefined;
    }
  }
  return {
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  };
}
