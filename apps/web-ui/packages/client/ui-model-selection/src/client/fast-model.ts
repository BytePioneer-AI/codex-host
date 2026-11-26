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

function targetModelOf(
  groups: readonly ModelProviderGroup[],
  selection: Pick<ModelSelection, "provider" | "model">,
): ModelCatalogModel | undefined {
  const models = groups.find((group) => group.id === selection.provider)?.models;
  return models?.find((model) => model.id === selection.model) ?? catalogModelOf(groups, selection);
}

function supportedEffortOf(
  model: ModelCatalogModel | undefined,
  effort: string | undefined,
): string | undefined {
  if (effort === undefined) return undefined;
  return model?.reasoning?.efforts.some((option) => option.id === effort) ? effort : undefined;
}

export function modelRowSelection(
  groups: readonly ModelProviderGroup[],
  current: ModelSelection | null,
  selection: ModelSelection,
): ModelSelection {
  if (current?.provider !== selection.provider) return selection;
  const base = catalogModelOf(groups, current);
  const sameFamily =
    base !== undefined && (selection.model === base.id || selection.model === base.ultrafastModel);
  const model =
    sameFamily && selection.model === base.id && current.model === base.fastModel
      ? current.model
      : selection.model;
  const target = targetModelOf(groups, { provider: selection.provider, model });
  const preservedEffort =
    model === current.model
      ? current.reasoningEffort
      : supportedEffortOf(target, current.reasoningEffort);
  const reasoningEffort =
    preservedEffort ?? (model === current.model ? selection.reasoningEffort : undefined);
  return {
    provider: selection.provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}
