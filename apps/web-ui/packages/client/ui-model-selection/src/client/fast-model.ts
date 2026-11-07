/** A Fast Model ref is a variant of its catalog Model, not another Model row. */
import type {
  ModelCatalogModel,
  ModelProviderGroup,
  ModelSelection,
} from "@deepseek-ai/dsh-api-session-controller/types";

/** Whether `modelId` selects this catalog Model, either plain or as its Fast variant. */
export function isModelRoute(model: ModelCatalogModel, modelId: string): boolean {
  return model.id === modelId || model.fastModel === modelId;
}

/** The catalog Model a selection routes to, resolving a Fast ref to its base Model. */
export function catalogModelOf(
  groups: readonly ModelProviderGroup[],
  selection: Pick<ModelSelection, "provider" | "model">,
): ModelCatalogModel | undefined {
  return groups
    .find((group) => group.id === selection.provider)
    ?.models.find((model) => isModelRoute(model, selection.model));
}
