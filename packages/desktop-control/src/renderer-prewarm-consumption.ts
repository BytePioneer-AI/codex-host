/** Bind Desktop 26.1021 external draft creation and isolate its cwd-keyed pool.
 * Each invocation captures its route and prewarm consumption check before native
 * preparation awaits.
 * Self-contained because the controller embeds this installer in the Renderer.
 */
export function isolateRendererPrewarmConsumption(
  manager: unknown,
  discardExternal: (threadId: string) => void,
) {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object";
  if (!record(manager) || !record(manager.threadCreation)) return null;
  const creation = manager.threadCreation;
  const originalStart = manager.startConversation;
  const original = creation.createConversation;
  const params = creation.params;
  if (typeof originalStart !== "function" || typeof original !== "function" || !record(params))
    return null;
  const prototype: unknown = Object.getPrototypeOf(creation);
  if (!record(prototype) || typeof prototype.constructor !== "function") return null;
  // An invocation view is safe only for the reviewed params-only native class.
  // In particular, a class with private instance fields cannot use that view.
  if (
    Object.keys(creation).some((key) => key !== "params" && typeof creation[key] !== "function") ||
    /#[A-Za-z_$]/u.test(Function.prototype.toString.call(prototype.constructor))
  )
    return null;
  const pool = params.prewarmedThreadManager;
  if (
    !record(pool) ||
    typeof pool.hasPrewarmedThread !== "function" ||
    typeof pool.consumePrewarmedThread !== "function" ||
    typeof pool.deletePrewarmedThread !== "function"
  )
    return null;
  const consume = pool.consumePrewarmedThread;
  const hasPrewarm = pool.hasPrewarmedThread;
  const draftRoutes = new Map<string, { draftId: string; model: string }>();
  const draftIdentity = Symbol("codexhost draft creation");
  // A marker (even on a native copy) expires with this particular selection's route.
  const activeRoute = (marker: unknown) => {
    if (!record(marker) || typeof marker.draftId !== "string") return undefined;
    const route = draftRoutes.get(marker.draftId);
    return route === marker ? route : undefined;
  };
  const external = (model: unknown): model is string =>
    typeof model === "string" && model.startsWith("codexhost/");
  const routedStart = function (
    this: unknown,
    input: unknown,
    options: unknown,
    ...args: unknown[]
  ) {
    const draftId = record(options) ? options.clientThreadId : null;
    const mode = record(input) && record(input.collaborationMode) ? input.collaborationMode : null;
    const origin = mode ? Reflect.get(mode, draftIdentity) : undefined;
    if (mode && record(mode.settings) && external(mode.settings.model))
      return originalStart.call(this, input, options, ...args);
    const model =
      (typeof draftId === "string" ? draftRoutes.get(draftId)?.model : undefined) ??
      activeRoute(origin)?.model;
    if (!model) return originalStart.call(this, input, options, ...args);
    if (
      !record(input) ||
      !record(input.collaborationMode) ||
      !record(input.collaborationMode.settings)
    )
      throw new Error("External draft creation is missing its native Model settings");
    // Capture this draft's route before native preparation awaits. Codex reserve
    // fallback is Account-wide and cannot select the owner of an external Thread.
    const routed = {
      ...input,
      collaborationMode: {
        ...input.collaborationMode,
        settings: { ...input.collaborationMode.settings, model },
      },
    };
    return originalStart.call(this, routed, options, ...args);
  };
  const wrapped = function (this: unknown, input: unknown, ...args: unknown[]) {
    const mode = record(input) && record(input.collaborationMode) ? input.collaborationMode : null;
    const expected = mode && record(mode.settings) ? mode.settings.model : null;
    const scopedPool = Object.create(pool) as Record<string, unknown>;
    scopedPool.hasPrewarmedThread = (...parameters: unknown[]) =>
      hasPrewarm.apply(pool, parameters);
    scopedPool.consumePrewarmedThread = async (...consumeArgs: unknown[]) => {
      const warmed: unknown = await consume.apply(pool, consumeArgs);
      if (!record(warmed) || !record(warmed.response)) return warmed;
      const response = warmed.response;
      if (!external(expected) && !external(response.model)) return warmed;
      if (external(expected) && expected === response.model) return warmed;
      if (record(response.thread) && typeof response.thread.id === "string") {
        const threadId = response.thread.id;
        if (external(response.model)) discardExternal(threadId);
        else
          void Promise.resolve()
            .then(() => (pool.deletePrewarmedThread as (id: string) => unknown)(threadId))
            .catch(() => undefined);
      }
      return null;
    };
    // The reviewed native ThreadCreation class owns only `params`. Its methods
    // continue to register the real conversation through those native callbacks.
    const invocation = Object.create(creation) as Record<string, unknown>;
    invocation.params = { ...params, prewarmedThreadManager: scopedPool };
    return original.call(invocation, input, ...args);
  };
  creation.createConversation = wrapped;
  manager.startConversation = routedStart;
  return {
    selectDraft(
      draftId: string | undefined,
      model: string | null,
      creationModes: readonly Record<string, unknown>[] = [],
    ): void {
      if (draftId === undefined) {
        if (model === null) draftRoutes.clear();
      } else if (model === null) draftRoutes.delete(draftId);
      else {
        if (!draftId.startsWith("client-new-thread:") || !external(model))
          throw new Error("External draft route is missing its client Thread identity");
        const route = draftRoutes.get(draftId) ?? { draftId, model };
        const toMark = creationModes.filter((mode) => {
          const marker = Object.getOwnPropertyDescriptor(mode, draftIdentity);
          if (marker?.value === route) return false;
          if (
            marker ? activeRoute(marker.value) || !marker.configurable : !Object.isExtensible(mode)
          )
            throw new Error("External creation mode cannot be marked for this draft");
          return true;
        });
        // Native preparation shallow-copies modes when it overrides effort.
        // Symbols survive those copies and are omitted from RPC JSON.
        for (const mode of toMark)
          Object.defineProperty(mode, draftIdentity, {
            configurable: true,
            enumerable: true,
            value: route,
          });
        route.model = model;
        draftRoutes.set(draftId, route);
      }
    },
    dispose() {
      draftRoutes.clear();
      if (manager.startConversation === routedStart) manager.startConversation = originalStart;
      if (creation.createConversation === wrapped) creation.createConversation = original;
    },
  };
}
