const INTERNAL_LEVELS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

function validOptions(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((option) => typeof option === "string" && option.trim()) &&
    new Set(value).size === value.length
  );
}

/** Match Desktop's native ModelReasoningConfig and internal-user request field. */
function modelThinkingPolicy(model, internal = false) {
  if (model.config_source === 3) {
    const legacy = model.reasoning_param;
    if (
      !model.reasoning_effort_config &&
      model.thinking_enable === 1 &&
      typeof legacy?.parameter === "string" &&
      legacy.parameter.trim() &&
      validOptions(legacy.values)
    )
      return { field: "reasoning_effort_level", options: [...legacy.values] };
  } else if (internal) {
    if (!Array.isArray(model.reasoning_effort_options)) return undefined;
    const options = [
      ...new Set(model.reasoning_effort_options.map((level) => String(level).trim().toLowerCase())),
    ].filter((level) => INTERNAL_LEVELS.has(level));
    return options.length ? { field: "reasoning_effort", options } : undefined;
  }
  const config = model.reasoning_effort_config;
  if (config?.support_thinking !== true || !validOptions(config.options)) return undefined;
  if (model.config_source === 3) {
    if (typeof config.parameter !== "string" || !config.parameter.trim()) return undefined;
  } else if (
    typeof config.default_level !== "string" ||
    !config.options.includes(config.default_level)
  ) {
    return undefined;
  }
  return { field: "reasoning_effort_level", options: [...config.options] };
}

function requestedThinking(model, request, settings = {}) {
  if (request === undefined) return undefined;
  const policy = modelThinkingPolicy(model, settings.internal === true);
  if (!policy)
    throw Object.assign(new Error("This native model does not support Thinking selection"), {
      code: "unsupported",
    });
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    request.field !== policy.field ||
    !policy.options.includes(request.level)
  )
    throw Object.assign(new Error("Thinking selection is not available for this native model"), {
      code: "invalidRequest",
    });
  return { field: policy.field, level: request.level };
}

module.exports = { modelThinkingPolicy, requestedThinking };
