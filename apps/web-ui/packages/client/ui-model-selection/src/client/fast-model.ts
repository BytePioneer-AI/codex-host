import type {
  ModelCatalogModel,
  ModelProviderGroup,
  ModelSelection,
} from "@deepseek-ai/dsh-api-session-controller/types";

/** Fast shares its base model row. Ultrafast has a selectable row of its own. */
export function isModelRoute(model: ModelCatalogModel, modelId: string): boolean {
  return model.id === modelId || model.fastModel === modelId;
}

/** Resolve any speed variant to the base Model that owns its speed control. */
export function catalogModelOf(
  groups: readonly ModelProviderGroup[],
  selection: Pick<ModelSelection, "provider" | "model">,
): ModelCatalogModel | undefined {
  const models = groups.find((group) => group.id === selection.provider)?.models;
  return (
    models?.find((model) => model.ultrafastModel === selection.model) ??
    models?.find((model) => isModelRoute(model, selection.model))
  );
}

export function modelRowSelection(
  groups: readonly ModelProviderGroup[],
  current: ModelSelection | null,
  selection: ModelSelection,
): ModelSelection {
  if (current?.provider !== selection.provider) return selection;
  const base = catalogModelOf(groups, current);
  if (!base || (selection.model !== base.id && selection.model !== base.ultrafastModel))
    return selection;
  const model =
    selection.model === base.id && current.model === base.fastModel
      ? current.model
      : selection.model;
  const reasoningEffort =
    current.reasoningEffort ?? (model === current.model ? selection.reasoningEffort : undefined);
  return {
    provider: selection.provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}
