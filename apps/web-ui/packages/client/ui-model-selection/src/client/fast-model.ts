import type {
  ModelCatalogModel,
  ModelProviderGroup,
  ModelSelection,
} from "@deepseek-ai/dsh-api-session-controller/types";

/** Whether `modelId` selects this catalog Model or one of its speed variants. */
export function isModelRoute(model: ModelCatalogModel, modelId: string): boolean {
  return model.id === modelId || model.fastModel === modelId || model.ultrafastModel === modelId;
}

/** Resolve a selection, including a speed variant, to its catalog Model. */
export function catalogModelOf(
  groups: readonly ModelProviderGroup[],
  selection: Pick<ModelSelection, "provider" | "model">,
): ModelCatalogModel | undefined {
  return groups
    .find((group) => group.id === selection.provider)
    ?.models.find((model) => isModelRoute(model, selection.model));
}
