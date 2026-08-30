import Schema from "@deepseek-ai/schemastery";
import type {
  SessionProjectionsBlock,
  SettingsNamespaceView,
} from "@deepseek-ai/dsh-host-apiproxy/api";

import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

import { DeepSeekHarnessTransportError } from "./host-client.js";

const PERMISSION_SETTINGS_NAMESPACE = "permission";
const PERMISSION_PROJECTION_KEY = "permissions";
const CUSTOM_PERMISSION_MODE_ID = "custom";

interface SchemaNode {
  readonly type?: unknown;
  readonly value?: unknown;
  readonly list?: unknown;
  readonly dict?: Record<string, SchemaNode>;
  readonly meta?: { readonly description?: unknown };
}

export interface DeepSeekPermissionModeState {
  permissionModeId: HarnessPermissionModeId;
  projectionSeq: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function protocolError(area: string, error: unknown): DeepSeekHarnessTransportError {
  return new DeepSeekHarnessTransportError(
    "protocolError",
    `DeepSeek Harness returned an invalid Permission Mode ${area}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

export function normalizeDeepSeekPermissionModeCatalog(
  namespaces: readonly SettingsNamespaceView[],
): HarnessPermissionModeCatalog | null {
  const matches = namespaces.filter(({ ns }) => ns === PERMISSION_SETTINGS_NAMESPACE);
  if (matches.length === 0) return null;
  try {
    if (matches.length !== 1) throw new Error("duplicate permission settings namespaces");
    const view = matches[0] as SettingsNamespaceView;
    const defaultModeId = record(view.value)?.defaultPreset;
    if (typeof defaultModeId !== "string") {
      throw new Error("permission settings has no defaultPreset value");
    }
    const root = new Schema(view.schema as never) as unknown as SchemaNode;
    const field = root.type === "object" ? root.dict?.defaultPreset : undefined;
    if (!field) throw new Error("permission settings schema has no defaultPreset field");
    const choices = field.type === "union" ? field.list : [field];
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error("permission settings schema has no preset choices");
    }
    const modes = choices.map((candidate) => {
      const choice = candidate as SchemaNode;
      if (choice.type !== "const" || typeof choice.value !== "string") {
        throw new Error("permission settings schema contains a non-constant preset choice");
      }
      if (choice.value === CUSTOM_PERMISSION_MODE_ID) {
        throw new Error("permission settings schema advertises the reserved custom state");
      }
      const described = choice.meta?.description;
      return {
        id: choice.value,
        label:
          typeof described === "string" && described.trim().length > 0 ? described : choice.value,
      };
    });
    return harnessPermissionModeCatalogSchema.parse({ modes, defaultModeId });
  } catch (error) {
    throw protocolError("catalog", error);
  }
}

function normalizeProjection(
  value: unknown,
  catalog: HarnessPermissionModeCatalog,
): HarnessPermissionModeId {
  const projection = record(value);
  if (!projection || !Array.isArray(projection.options)) {
    throw new Error("projection has no options");
  }
  if (typeof projection.currentValue !== "string") {
    throw new Error("projection has no currentValue");
  }
  const ids = projection.options.map((value) => {
    const option = record(value);
    if (
      !option ||
      typeof option.value !== "string" ||
      typeof option.name !== "string" ||
      option.name.trim().length === 0 ||
      (option.description !== undefined && typeof option.description !== "string")
    ) {
      throw new Error("projection contains an invalid option");
    }
    return harnessPermissionModeIdSchema.parse(option.value);
  });
  if (new Set(ids).size !== ids.length) throw new Error("projection contains duplicate options");
  const customIndex = ids.indexOf(CUSTOM_PERMISSION_MODE_ID as HarnessPermissionModeId);
  if (customIndex >= 0 && customIndex !== ids.length - 1) {
    throw new Error("projection does not append its custom state");
  }
  if (customIndex >= 0 && projection.currentValue !== CUSTOM_PERMISSION_MODE_ID) {
    throw new Error("projection advertises custom when it is not current");
  }
  const selectableIds = ids.filter((id) => id !== CUSTOM_PERMISSION_MODE_ID);
  const catalogIds = catalog.modes.map(({ id }) => id);
  if (
    selectableIds.length !== catalogIds.length ||
    selectableIds.some((id, index) => id !== catalogIds[index])
  ) {
    throw new Error("projection options disagree with the inspected catalog");
  }
  const currentModeId = harnessPermissionModeIdSchema.parse(projection.currentValue);
  if (
    currentModeId !== CUSTOM_PERMISSION_MODE_ID &&
    !catalogIds.some((id) => id === currentModeId)
  ) {
    throw new Error("projection currentValue is not selectable");
  }
  if (currentModeId === CUSTOM_PERMISSION_MODE_ID && customIndex < 0) {
    throw new Error("projection omitted its current custom option");
  }
  return currentModeId;
}

export function readDeepSeekPermissionModeState(
  projections: SessionProjectionsBlock | undefined,
  catalog: HarnessPermissionModeCatalog | null,
): DeepSeekPermissionModeState | undefined {
  const values = projections ? record(projections.values) : null;
  const hasProjection =
    values !== null && Object.prototype.hasOwnProperty.call(values, PERMISSION_PROJECTION_KEY);
  if (!catalog) {
    if (hasProjection) {
      throw protocolError("projection", "permissions exist without a settings catalog");
    }
    return undefined;
  }
  if (!projections || !hasProjection) {
    throw protocolError("projection", "the permissions projection is missing");
  }
  try {
    return {
      permissionModeId: normalizeProjection(values[PERMISSION_PROJECTION_KEY], catalog),
      projectionSeq: projections.asOfSeq,
    };
  } catch (error) {
    throw protocolError("projection", error);
  }
}

export function readDeepSeekLivePermissionMode(
  value: unknown,
  catalog: HarnessPermissionModeCatalog | null,
): HarnessPermissionModeId {
  if (!catalog) throw protocolError("projection", "permissions exist without a settings catalog");
  try {
    return normalizeProjection(value, catalog);
  } catch (error) {
    throw protocolError("projection", error);
  }
}

export function isDeepSeekPermissionModeSelectable(
  catalog: HarnessPermissionModeCatalog,
  permissionModeId: HarnessPermissionModeId,
): boolean {
  return catalog.modes.some(({ id }) => id === permissionModeId);
}
