import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  harnessInspectionSchema,
  threadInspectionSchema,
  type HarnessInspection,
  type ThreadInspection,
} from "@codexhost/shared-contracts";
import type { ChThreadView } from "./ch-thread-view.ts";
import { groupOf, type Inspection } from "./harnesses.ts";
import { nativePermissionView } from "./session-presentation.ts";
import { RpcError } from "./transport.ts";

const remoteHarnessDescriptorSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    icon: z.string().optional(),
  })
  .passthrough();

export interface RemoteControlsSnapshot {
  configuration?: unknown;
  inspection?: unknown;
  harness?: unknown;
}

export interface RemoteControls {
  configuration?: ThreadInspection;
  inspection?: HarnessInspection;
  harness?: z.infer<typeof remoteHarnessDescriptorSchema>;
}

export type ExternalThreadInspection = Extract<ThreadInspection, { owner: "external" }>;
export type RemoteConfigurationSetting =
  { modelId: string } | { thinkingOptionId: string } | { permissionModeId: string };

export interface RemoteControlsEntry {
  controls?: RemoteControls;
  row: { modelProvider: string };
}

export function parseRemoteControls(snapshot: RemoteControlsSnapshot): RemoteControls {
  const controls: RemoteControls = {};
  const configuration = threadInspectionSchema.safeParse(snapshot.configuration);
  if (configuration.success) controls.configuration = configuration.data;
  const inspection = harnessInspectionSchema.safeParse(snapshot.inspection);
  if (inspection.success) controls.inspection = inspection.data;
  const harness = remoteHarnessDescriptorSchema.safeParse(snapshot.harness);
  if (harness.success) controls.harness = harness.data;
  return controls;
}

function sameOwner(a: ThreadInspection, b: ThreadInspection): boolean {
  if (a.owner !== b.owner) return false;
  return a.owner !== "external" || a.harnessId === (b as ExternalThreadInspection).harnessId;
}

/** Keep the last confirmed control metadata during a same-epoch partial read. */
export function mergeRemoteControls(
  previous: RemoteControls | undefined,
  next: RemoteControls,
  sameEpoch: boolean,
): RemoteControls {
  if (!sameEpoch || previous === undefined) return next;
  const previousConfiguration = previous.configuration;
  const nextConfiguration = next.configuration;
  if (
    previousConfiguration !== undefined &&
    nextConfiguration !== undefined &&
    !sameOwner(previousConfiguration, nextConfiguration)
  )
    return next;
  const configuration = nextConfiguration ?? previousConfiguration;
  if (configuration === undefined) return next;
  const previousExternal =
    previousConfiguration?.owner === "external" ? previousConfiguration : undefined;
  const external = configuration.owner === "external" ? configuration : undefined;
  const previousHarness =
    external && previousExternal?.harnessId === external.harnessId ? previous.harness : undefined;
  const nextHarness =
    external && next.harness?.id === external.harnessId ? next.harness : undefined;
  const merged: RemoteControls = { configuration };
  const inspection = next.inspection ?? previous.inspection;
  if (inspection !== undefined) merged.inspection = inspection;
  const harness = nextHarness ?? previousHarness;
  if (harness !== undefined) merged.harness = harness;
  return merged;
}

export function remoteHarnessIdentity(
  entry: RemoteControlsEntry,
): { id: string; name: string; icon?: string } | undefined {
  const configuration = entry.controls?.configuration;
  if (configuration?.owner === "external") {
    const descriptor =
      entry.controls?.harness?.id === configuration.harnessId ? entry.controls.harness : undefined;
    return {
      id: configuration.harnessId,
      name: descriptor?.name ?? configuration.harnessId,
      ...(descriptor?.icon ? { icon: descriptor.icon } : {}),
    };
  }
  if (configuration?.owner === "codex" || entry.row.modelProvider !== "codexhost")
    return { id: "codex", name: "Codex" };
  return undefined;
}

export function viewHarnessId(entry: RemoteControlsEntry): string {
  const configuration = entry.controls?.configuration;
  if (configuration?.owner === "external") return configuration.harnessId;
  if (configuration?.owner === "codex" || entry.row.modelProvider !== "codexhost") return "codex";
  // A remote row without ownership metadata is still a remote row. Do not
  // give it the local Codex view or local control semantics.
  return "remote";
}

export function applyRemoteControls(entry: RemoteControlsEntry, view: ChThreadView): void {
  const configuration = entry.controls?.configuration;
  const external = configuration?.owner === "external" ? configuration : undefined;
  const inspection = entry.controls?.inspection;
  const nativePermissions =
    external && inspection
      ? nativePermissionView(
          external.harnessId,
          inspection as Inspection,
          true,
          inspection.status === "ready" ? inspection.capabilities.configuration : undefined,
        )
      : null;
  view.log.setProjection("nativePermissions", nativePermissions);
  view.log.setProjection("permissions", {
    currentValue: external?.effectivePermissionModeId ?? "",
  });
  const selection =
    external?.effectiveModel === undefined
      ? null
      : {
          provider: external.harnessId,
          model: external.effectiveModel.id,
          ...(external.effectiveThinkingOptionId
            ? { reasoningEffort: external.effectiveThinkingOptionId }
            : {}),
        };
  view.log.setProjection("modelSelection", { lastUsed: selection, next: selection });
}

export function externalConfiguration(entry: RemoteControlsEntry): ExternalThreadInspection {
  const configuration = entry.controls?.configuration;
  if (!configuration || configuration.owner !== "external")
    throw new RpcError(
      "remote/unsupported",
      "Remote Harness configuration is unavailable for this Thread.",
    );
  return configuration;
}

export function remoteModelCatalog(entry: RemoteControlsEntry) {
  const configuration = externalConfiguration(entry);
  const inspection = entry.controls?.inspection;
  if (!inspection || inspection.status !== "ready")
    throw new RpcError(
      "remote/unsupported",
      "Remote Harness model discovery is unavailable for this Thread.",
    );
  const group = groupOf(
    configuration.harnessId,
    remoteHarnessIdentity(entry)?.name ?? configuration.harnessId,
    inspection as Extract<Inspection, { status: "ready" }>,
  );
  const model =
    configuration.effectiveModel?.id ?? inspection.catalog.defaultModel?.id ?? group.models[0]?.id;
  if (!model) throw new RpcError("remote/unsupported", "Remote Harness has no advertised models.");
  return {
    default: { provider: configuration.harnessId, model },
    routableProviders: [configuration.harnessId],
    groups: [group],
    failures: [],
  };
}

export async function selectRemoteModel(
  id: string,
  entry: RemoteControlsEntry,
  request: Record<string, unknown>,
  configure: (entry: RemoteControlsEntry, setting: RemoteConfigurationSetting) => Promise<void>,
  refresh: (id: string) => Promise<unknown>,
): Promise<Record<string, never>> {
  const configuration = externalConfiguration(entry);
  if (typeof request.provider !== "string" || request.provider !== configuration.harnessId)
    throw new RpcError(
      "session/model-unavailable",
      "The selected model belongs to a different Harness.",
    );
  if (typeof request.model !== "string" || !request.model)
    throw new RpcError("session/model-unavailable", "A remote model is required.");
  if (
    request.reasoningEffort !== undefined &&
    (typeof request.reasoningEffort !== "string" || !request.reasoningEffort)
  )
    throw new RpcError("session/model-unavailable", "The remote thinking option is invalid.");
  let changed = false;
  let refreshedAfterModel = false;
  let currentConfiguration = configuration;
  if (currentConfiguration.effectiveModel?.id !== request.model) {
    await configure(entry, { modelId: request.model });
    changed = true;
    if (typeof request.reasoningEffort === "string") {
      try {
        await refresh(id);
        currentConfiguration = externalConfiguration(entry);
        refreshedAfterModel = true;
      } catch {
        throw new RpcError(
          "remote/configuration-incomplete",
          "Model change was confirmed, but Thinking was not completed. Refresh before deciding whether to retry.",
        );
      }
    }
  }
  if (
    typeof request.reasoningEffort === "string" &&
    (!changed || refreshedAfterModel) &&
    request.reasoningEffort !== currentConfiguration.effectiveThinkingOptionId
  ) {
    await configure(entry, { thinkingOptionId: request.reasoningEffort });
    changed = true;
    refreshedAfterModel = false;
  }
  if (changed && !refreshedAfterModel) await refresh(id).catch(() => undefined);
  return {};
}

export async function executeRemoteCommand(
  id: string,
  entry: RemoteControlsEntry,
  request: Record<string, unknown>,
  configure: (entry: RemoteControlsEntry, setting: RemoteConfigurationSetting) => Promise<void>,
  refresh: (id: string) => Promise<unknown>,
): Promise<unknown> {
  if (typeof request.line !== "string") return undefined;
  const match = /^\/permission\s+(.+)$/u.exec(request.line);
  if (!match) return undefined;
  const configuration = externalConfiguration(entry);
  const inspection = entry.controls?.inspection;
  const permissionView =
    inspection === undefined
      ? null
      : nativePermissionView(
          configuration.harnessId,
          inspection as Inspection,
          true,
          inspection.status === "ready" ? inspection.capabilities.configuration : undefined,
        );
  const modeId = match[1]?.trim() ?? "";
  const mode =
    inspection?.status === "ready"
      ? inspection.permissionModes?.modes.find((value) => value.id === modeId)
      : undefined;
  if (!permissionView?.selectable || permissionView.locked || !mode)
    throw new RpcError(
      "session/permission-unavailable",
      "Mode is not selectable for this remote Harness Thread.",
    );
  await configure(entry, { permissionModeId: modeId });
  await refresh(id).catch(() => undefined);
  return { commandId: randomUUID(), result: { kind: "success", text: mode.label } };
}
