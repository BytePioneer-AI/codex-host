import type { CopilotClient, CopilotSession, GetAuthStatusResponse } from "@github/copilot-sdk";
import { z } from "zod";
import { bounded, CopilotOperationError } from "./errors.js";
import type { HarnessSessionState } from "@codexhost/harness-adapter";
import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

export function modelRef(id: string): HarnessModelRef {
  return harnessModelRefSchema.parse({ id: Buffer.from(id).toString("base64url") });
}

export function modelId(ref: HarnessModelRef): string {
  const parsed = harnessModelRefSchema.parse(ref);
  const id = Buffer.from(parsed.id, "base64url").toString("utf8");
  if (!id || modelRef(id).id !== parsed.id)
    throw new CopilotOperationError("invalidRequest", "Invalid Copilot Model reference.");
  return id;
}

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  supportedReasoningEfforts: z.array(z.string().min(1)).optional(),
  policy: z.object({ state: z.string() }).optional(),
});
export type CopilotModel = z.infer<typeof modelSchema>;

/** Auto is the native Copilot routing choice, not a concrete model or an effort tier. */
export async function readModels(
  client: CopilotClient,
  session?: CopilotSession,
  auth?: GetAuthStatusResponse,
  refresh = true,
): Promise<CopilotModel[]> {
  let entries: unknown[];
  let auto: boolean;
  if (session) {
    const result = await bounded(session.rpc.model.list({ skipCache: refresh }));
    entries = result.list;
    auto = !!result.auto || !!result.providers?.some((provider) => provider.kind === "copilot");
  } else {
    const result = await bounded(client.rpc.models.list({}));
    const identity = auth ?? (await bounded(client.getAuthStatus()));
    entries = result.models;
    // CLI 1.0.102 omits virtual Auto from both model lists, including on Auto-only plans.
    auto =
      !!result.auto ||
      (identity.isAuthenticated &&
        ["user", "env", "gh-cli", "hmac", "token"].includes(identity.authType ?? ""));
  }
  const models = entries.map((entry) => modelSchema.parse(entry));
  if (auto && !models.some((model) => model.id === "auto"))
    models.unshift({ id: "auto", name: "Auto" });
  return models.filter((model) => model.policy?.state !== "disabled");
}

export function requireModel(models: CopilotModel[], id: string): CopilotModel {
  const model = models.find((entry) => entry.id === id);
  if (!model)
    throw new CopilotOperationError(
      "invalidRequest",
      "Copilot does not offer this Model in the current native catalog.",
    );
  return model;
}

export async function selectThinking(
  session: CopilotSession,
  models: CopilotModel[],
  model: string | undefined,
  effort: string,
): Promise<void> {
  if (!model) throw new CopilotOperationError("invalidState", "Copilot has not confirmed a Model.");
  if (!requireModel(models, model).supportedReasoningEfforts?.includes(effort))
    throw new CopilotOperationError(
      "invalidRequest",
      "Copilot did not advertise this Thinking option for the selected Model.",
    );
  await bounded(session.rpc.model.setReasoningEffort({ reasoningEffort: effort }));
}

export function modelCatalog(models: CopilotModel[]) {
  const efforts = [...new Set(models.flatMap((model) => model.supportedReasoningEfforts ?? []))];
  // Initial Desktop choice; effective native configuration is still confirmed by the Session.
  const initial = models.find((model) => model.id === "auto") ?? models[0];
  return harnessModelCatalogSchema.parse({
    models: models.map((model) => ({
      ref: modelRef(model.id),
      label: model.name,
      supportedThinkingOptionIds: model.supportedReasoningEfforts ?? [],
    })),
    thinkingOptions: efforts.map((id) => ({ id, label: id })),
    ...(initial ? { defaultModel: modelRef(initial.id) } : {}),
  });
}

export async function confirmedConfiguration(
  session: CopilotSession,
  client: CopilotClient,
): Promise<HarnessSessionState> {
  const [model, permission] = await Promise.all([
    session.rpc.model.getCurrent(),
    session.rpc.permissions.getMode(),
  ]);
  const models = await readModels(client, session, undefined, false);
  const entry = models.find((entry) => entry.id === model.modelId);
  return {
    ...(model.modelId ? { effectiveModel: modelRef(model.modelId) } : {}),
    ...(entry ? { resolvedModelLabel: entry.name } : {}),
    ...(model.reasoningEffort && entry?.supportedReasoningEfforts?.includes(model.reasoningEffort)
      ? { effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse(model.reasoningEffort) }
      : {}),
    ...(entry
      ? {
          availableThinkingOptions: (entry.supportedReasoningEfforts ?? []).map((id) => ({
            id: harnessThinkingOptionIdSchema.parse(id),
            label: id,
          })),
        }
      : {}),
    effectivePermissionModeId: harnessPermissionModeIdSchema.parse(permission.mode),
  };
}
