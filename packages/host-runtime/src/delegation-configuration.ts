import type { RoutedHarnessId } from "@codexhost/protocol-core";
import {
  canonicalizeOfficialCodexModelRef,
  catalogModelForRef,
  type HarnessDelegationDefault,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

import {
  DelegationControlError,
  type DelegationStartInput,
  type HarnessInspectResult,
} from "./delegation-types.js";

export async function resolveDelegationConfiguration(input: {
  harnessId: RoutedHarnessId;
  explicit: HarnessDelegationDefault;
  readDefault: () => Promise<HarnessDelegationDefault | undefined>;
  inspect: () => Promise<HarnessInspectResult>;
}): Promise<Pick<DelegationStartInput, "model" | "thinkingOptionId">> {
  const official = input.harnessId === "codex";
  const { model: explicitModel, thinkingOptionId: explicitThinking } = input.explicit;
  let saved =
    explicitModel && explicitThinking
      ? undefined
      : await input.readDefault().catch(() => undefined);
  if (official && saved?.model) {
    try {
      saved = { ...saved, model: canonicalizeOfficialCodexModelRef(saved.model) };
    } catch {
      saved = undefined;
    }
  }

  let model = explicitModel ?? saved?.model;
  let thinkingOptionId =
    explicitThinking ??
    (!explicitModel || explicitModel.id === saved?.model?.id ? saved?.thinkingOptionId : undefined);
  if (!model && !thinkingOptionId) return {};

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
            !official && fastModel ? [ref.id, fastModel.id] : [ref.id],
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
