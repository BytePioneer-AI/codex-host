function availableModels(models) {
  if (!Array.isArray(models)) throw new Error("TRAE CN returned an invalid model catalog");
  const seen = new Set();
  return models.filter((model) => {
    if (
      !model ||
      typeof model.name !== "string" ||
      !model.name ||
      model.selectable === false ||
      model.status === false ||
      seen.has(model.name)
    )
      return false;
    seen.add(model.name);
    return true;
  });
}

/** A public projection; provider credentials never leave the desktop extension. */
function publicModels(models) {
  return availableModels(models).map((model) => ({
    id: model.name,
    label:
      typeof model.display_name === "string" && model.display_name
        ? model.display_name
        : model.name,
    multimodal: model.multimodal === true,
    provider: typeof model.provider === "string" ? model.provider : "",
  }));
}

/** The model-management list is not the conversation picker catalog. */
async function readModels(native, agentType, refresh = false) {
  if (typeof agentType !== "string" || !/^[a-z][a-z0-9_]*$/.test(agentType))
    throw new Error("Invalid TRAE CN native agent type");
  const catalog = await native.call("model", "model_list_by_function", {
    functions: [agentType],
    force_refresh: refresh,
  });
  const groups = catalog?.list?.filter((group) => group.function === agentType);
  if (!Array.isArray(groups) || groups.length !== 1 || !Array.isArray(groups[0].models))
    throw new Error("TRAE CN did not report the requested conversation model pool");
  return availableModels(groups[0].models);
}

/** Match the app's custom-model request DTO, including remote credential ownership. */
function nativeModel(models, id) {
  const model = availableModels(models).find((model) => model.name === id);
  if (!model) throw new Error("The selected model is no longer available in TRAE CN");
  return {
    provider: model.provider || "",
    config_name: model.name,
    display_model_name: model.display_name,
    multimodal: model.multimodal === true,
    ak: model.ak || "",
    use_remote_service: !model.client_connect,
    is_preset: model.is_preset === true,
    config_source: model.config_source,
    custom_model_id: model.custom_model_id,
    base_url: model.base_url || "",
    context_window_size: model.selected_max_context_window_size,
    region: model.region,
    sk: model.sk || "",
    auth_type: model.auth_type || 0,
    custom_model_type: model.custom_model_type,
    max_tokens: model.max_tokens,
    max_turn: model.max_turn,
    prompt_max_tokens: model.prompt_max_tokens,
  };
}

module.exports = { publicModels, nativeModel, readModels };
