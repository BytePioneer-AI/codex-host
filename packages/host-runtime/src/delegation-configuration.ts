import {
  catalogModelForRef,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";
import { DelegationControlError } from "./delegation-types.js";

export interface DelegationConfigurationSelectors {
  model?: string | undefined;
  thinking?: string | undefined;
}

export interface ResolvedDelegationConfiguration {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
}

/**
 * Resolves caller-provided Model and Thinking selectors against a ready HarnessModelCatalog.
 * Accepts either catalog IDs or nativeIds for both Model and Thinking selectors.
 */
export function resolveDelegationConfiguration(
  catalog: HarnessModelCatalog,
  selectors: DelegationConfigurationSelectors,
): ResolvedDelegationConfiguration {
  let matchedModelEntry = undefined;
  let matchedModelRef: HarnessModelRef | undefined = undefined;
  if (selectors.model !== undefined) {
    for (const candidate of catalog.models) {
      if (candidate.ref.id === selectors.model || candidate.nativeId === selectors.model) {
        matchedModelEntry = candidate;
        matchedModelRef = candidate.ref;
        break;
      }
      if (candidate.fastModel?.id === selectors.model) {
        matchedModelEntry = candidate;
        matchedModelRef = candidate.fastModel;
        break;
      }
    }
    if (!matchedModelEntry || !matchedModelRef) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Model is unavailable for the target Harness",
        {
          validModelIds: catalog.models.flatMap((candidate) => {
            const primary = candidate.nativeId ?? candidate.ref.id;
            return candidate.fastModel ? [primary, candidate.fastModel.id] : [primary];
          }),
        },
      );
    }
  }

  let matchedThinking = undefined;
  if (selectors.thinking !== undefined) {
    const selectedModelEntry =
      matchedModelEntry ?? catalogModelForRef(catalog, catalog.defaultModel);
    const supportedOptionIds = selectedModelEntry?.supportedThinkingOptionIds ?? [];
    const availableOptions = catalog.thinkingOptions.filter((option) =>
      supportedOptionIds.includes(option.id),
    );
    matchedThinking = availableOptions.find(
      (candidate) =>
        candidate.id === selectors.thinking || candidate.nativeId === selectors.thinking,
    );
    if (!matchedThinking) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Thinking option is unavailable for the selected Model",
        {
          validThinkingOptionIds: availableOptions.map(
            (candidate) => candidate.nativeId ?? candidate.id,
          ),
        },
      );
    }
  }

  return {
    ...(matchedModelRef ? { model: matchedModelRef } : {}),
    ...(matchedThinking ? { thinkingOptionId: matchedThinking.id } : {}),
  };
}
