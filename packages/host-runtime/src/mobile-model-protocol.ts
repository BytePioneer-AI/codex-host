import { decodeCreateRoute, type JsonObject, type JsonRpcRequest } from "@codexhost/protocol-core";
import {
  encodeHarnessPluginRoute,
  harnessModelRefSchema,
  harnessIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { object, type SharedThreadPeer } from "./shared-thread-peer.js";
import { mobileCatalogPage } from "./mobile-model-catalog.js";
import {
  modelPreferenceKey,
  mobilePreferencesVersion,
  type MobileModelPreferences,
} from "./mobile-model-preferences.js";

export const MOBILE_TURN_START = "codexhost/thread/mobile-turn/start";
export const MOBILE_MODEL_INSPECT = "codexhost/thread/mobile-model/inspect";
export const MOBILE_MODEL_CATALOG = "codexhost/harness/mobile-models/list";
type NativeRequest = (method: string, params: JsonObject) => Promise<JsonObject>;

function result(reply: JsonObject): JsonObject {
  if (object(reply.error)) throw new Error(String(reply.error.message ?? "Model operation failed"));
  if (!object(reply.result)) throw new Error("Invalid Model operation response");
  return reply.result;
}
function externalModel(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const route = decodeCreateRoute({ id: 0, method: "thread/start", params: { model } });
  return route != null && route.harnessId !== "codex";
}

/** Mobile-only standard protocol facade. Desktop keeps its existing extension protocol. */
export class MobileModelProtocol {
  constructor(
    readonly owner: SharedThreadPeer,
    readonly preferences: MobileModelPreferences,
  ) {}
  async catalog(native: NativeRequest, params: JsonObject): Promise<JsonObject> {
    const official: JsonObject[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = result(
        await native("model/list", {
          cursor,
          limit: 200,
          includeHidden: params.includeHidden === true,
        }),
      );
      if (!Array.isArray(page.data)) throw new Error("Invalid native Model catalog");
      official.push(...page.data.filter(object));
      if (official.length > 10000) throw new Error("Native Model catalog limit exceeded");
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
      if (cursor && seen.has(cursor)) throw new Error("Native Model cursor did not advance");
      if (cursor) seen.add(cursor);
    } while (cursor);
    const external = result(await this.owner.request(MOBILE_MODEL_CATALOG, {}));
    const entries = Array.isArray(external.data) ? external.data.filter(object) : [];
    return mobileCatalogPage([...official, ...entries], params);
  }
  async handle(request: JsonRpcRequest, native: NativeRequest): Promise<JsonObject | undefined> {
    const params = object(request.params) ? request.params : {};
    if (request.method === "thread/start" && externalModel(params.model)) {
      if (params.serviceTier != null)
        throw new Error("This Harness does not support Codex service tiers");
      const selected = decodeCreateRoute(request);
      // Legacy clients may create a Harness session with its native default Model.
      if (
        !selected?.model &&
        !(object(params.config) && params.config.model_reasoning_effort != null)
      )
        return undefined;
      const entries = result(await this.owner.request(MOBILE_MODEL_CATALOG, {})).data;
      const entry = Array.isArray(entries)
        ? entries.find((entry) => {
            if (!object(entry) || typeof entry.model !== "string") return false;
            const candidate = decodeCreateRoute({
              id: 0,
              method: "thread/start",
              params: { model: entry.model },
            });
            return (
              candidate?.harnessId === selected?.harnessId &&
              candidate?.model?.id === selected?.model?.id
            );
          })
        : undefined;
      if (!object(entry)) throw new Error("Selected Harness Model is no longer available");
      const effort = object(params.config) ? params.config.model_reasoning_effort : undefined;
      if (effort != null) {
        if (
          !Array.isArray(entry.supportedReasoningEfforts) ||
          !entry.supportedReasoningEfforts.some(
            (option) => object(option) && option.reasoningEffort === effort,
          )
        )
          throw new Error("Unsupported Harness thinking option");
        const route = decodeCreateRoute(request);
        if (route && route.harnessId !== "codex" && effort !== "none")
          request.params = {
            ...params,
            model: encodeHarnessPluginRoute({
              harnessId: harnessIdSchema.parse(route.harnessId),
              ...(route.model ? { model: route.model } : {}),
              ...(route.permissionModeId ? { permissionModeId: route.permissionModeId } : {}),
              thinkingOptionId: harnessThinkingOptionIdSchema.parse(effort),
            }),
          };
      }
    }
    if (request.method === "model/list")
      return { id: request.id, result: await this.catalog(native, params) };
    if (request.method === "config/read") {
      const reply = await native(request.method, params);
      if (object(reply.result) && object(reply.result.config)) {
        const preferences = await this.preferences.read();
        if (Object.keys(preferences).length) {
          const metadata = {
            name: { type: "user", file: this.preferences.file, profile: null },
            version: mobilePreferencesVersion(preferences),
          };
          const origins = { ...(object(reply.result.origins) ? reply.result.origins : {}) };
          for (const key of Object.keys(preferences)) origins[key] = metadata;
          reply.result = {
            ...reply.result,
            config: { ...reply.result.config, ...preferences },
            origins,
            ...(Array.isArray(reply.result.layers)
              ? { layers: [...reply.result.layers, { ...metadata, config: preferences }] }
              : {}),
          };
        }
      }
      return { ...reply, id: request.id };
    }
    if (request.method === "config/batchWrite" || request.method === "config/value/write") {
      const edits =
        request.method === "config/value/write"
          ? [params]
          : Array.isArray(params.edits)
            ? params.edits
            : [];
      const modelEdits = edits.filter(object).filter((edit) => modelPreferenceKey(edit.keyPath));
      if (!modelEdits.length) return undefined;
      if (modelEdits.length !== edits.length)
        throw new Error("Save mobile Model selection separately from other configuration changes");
      const nativeConfig = result(await native("config/read", { includeLayers: true }));
      const user = Array.isArray(nativeConfig.layers)
        ? nativeConfig.layers
            .filter(object)
            .find(
              (layer) => object(layer.name) && layer.name.type === "user" && !layer.name.profile,
            )
        : undefined;
      const userPath = user && object(user.name) ? user.name.file : undefined;
      if (
        params.filePath != null &&
        params.filePath !== userPath &&
        params.filePath !== this.preferences.file
      )
        throw new Error("Mobile Model defaults cannot modify project configuration");
      const modelEdit = modelEdits.find((edit) => edit.keyPath === "model");
      if (modelEdit) {
        let defaultEffort: string | null = null;
        if (externalModel(modelEdit.value)) {
          const available = result(await this.owner.request(MOBILE_MODEL_CATALOG, {}));
          const entry = Array.isArray(available.data)
            ? available.data.find((entry) => object(entry) && entry.model === modelEdit.value)
            : undefined;
          if (!object(entry)) throw new Error("Selected Harness Model is no longer available");
          defaultEffort =
            typeof entry.defaultReasoningEffort === "string" ? entry.defaultReasoningEffort : null;
          const effort = modelEdits.find(
            (edit) => edit.keyPath === "model_reasoning_effort",
          )?.value;
          if (
            effort != null &&
            (!Array.isArray(entry.supportedReasoningEfforts) ||
              !entry.supportedReasoningEfforts.some(
                (option) => object(option) && option.reasoningEffort === effort,
              ))
          )
            throw new Error("Unsupported Harness thinking option");
          if (modelEdits.some((edit) => edit.keyPath === "service_tier" && edit.value != null))
            throw new Error("This Harness does not support Codex service tiers");
        }
        // A new Model must not inherit another Model's thinking or speed defaults.
        if (!modelEdits.some((edit) => edit.keyPath === "model_reasoning_effort"))
          modelEdits.push({
            keyPath: "model_reasoning_effort",
            value: defaultEffort,
            mergeStrategy: "replace",
          });
        if (!modelEdits.some((edit) => edit.keyPath === "service_tier"))
          modelEdits.push({ keyPath: "service_tier", value: null, mergeStrategy: "replace" });
      }
      const saved = await this.preferences.write(
        modelEdits,
        params.expectedVersion,
        typeof user?.version === "string" ? user.version : undefined,
      );
      return { id: request.id, result: saved };
    }
    return undefined;
  }
  async projectThreadReply(reply: JsonObject, threadId: string): Promise<JsonObject> {
    if (
      !object(reply.result) ||
      typeof reply.result.model !== "string" ||
      !externalModel(reply.result.model)
    )
      return reply;
    const state = result(await this.owner.request(MOBILE_MODEL_INSPECT, { threadId }));
    const model = harnessModelRefSchema.safeParse(state.effectiveModel);
    if (!model.success || typeof state.harnessId !== "string") return reply;
    const source = decodeCreateRoute({
      id: 0,
      method: "thread/start",
      params: { model: reply.result.model },
    });
    if (!source || source.harnessId === "codex") return reply;
    return {
      ...reply,
      result: {
        ...reply.result,
        reasoningEffort:
          typeof state.effectiveThinkingOptionId === "string"
            ? state.effectiveThinkingOptionId
            : null,
        serviceTier: null,
        model: encodeHarnessPluginRoute({
          harnessId: harnessIdSchema.parse(state.harnessId),
          model: model.data,
        }),
      },
    };
  }
}
