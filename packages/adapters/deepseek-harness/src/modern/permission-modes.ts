import { Buffer } from "node:buffer";

import {
  HARNESS_PERMISSION_MODE_CATALOG_MAX_LENGTH,
  HARNESS_PERMISSION_MODE_DESCRIPTION_MAX_LENGTH,
  HARNESS_PERMISSION_MODE_LABEL_MAX_LENGTH,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionMode,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

import type { ModernProjectionRow } from "./control-store.js";
import { ModernRemoteConnectionError } from "./remote-connection.js";
import {
  redactModernCredential,
  sanitizeModernRemoteFailure,
  type ModernRemoteResult,
} from "./wire.js";

/** DSH serves its selectable presets from this process-level Remote. */
const PERMISSION_CATALOG_ENDPOINT = "permissionPresets/catalog";
/** Gateway fault for a Remote whose Service this DSH composition does not include. */
const SERVICE_UNAVAILABLE = "gateway/service-unavailable";
const CUSTOM_PERMISSION_MODE_ID = "custom";
/** DSH reserves `auto` for a preset that a live integration may add after a catalog read. */
const AUTO_PERMISSION_MODE_ID = "auto";
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_CATALOG_DEPTH = 64;
const MAX_CATALOG_NODES = 200_000;

export type ModernPermissionModeErrorCode =
  | "authenticationRequired"
  | "cancelled"
  | "limitExceeded"
  | "notInstalled"
  | "processExited"
  | "protocolError"
  | "remoteError"
  | "unavailable";

export class ModernPermissionModeError extends Error {
  readonly nativeCode?: string;

  constructor(
    readonly code: ModernPermissionModeErrorCode,
    message: string,
    nativeCode?: string,
  ) {
    super(redactModernCredential(message));
    this.name = "ModernPermissionModeError";
    if (nativeCode !== undefined) this.nativeCode = redactModernCredential(nativeCode);
  }
}

export interface ModernPermissionModeRemote {
  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ModernRemoteResult<T>>;
}

export interface ModernPermissionModeState {
  readonly permissionModeId: HarnessPermissionModeId;
  readonly projectionSeq: number;
}

function connectionError(
  error: ModernRemoteConnectionError,
  endpoint: string,
): ModernPermissionModeError {
  return permissionError(
    error.code,
    `DeepSeek Harness ${endpoint} request failed: ${error.message}`,
    error.nativeCode,
  );
}

function permissionError(
  code: ModernPermissionModeErrorCode,
  message: string,
  nativeCode?: string,
): ModernPermissionModeError {
  return new ModernPermissionModeError(code, message, nativeCode);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key))
  );
}

function assertBoundedJson(value: unknown): void {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (depth > MAX_CATALOG_DEPTH || nodes > MAX_CATALOG_NODES) {
      throw permissionError(
        "limitExceeded",
        "DeepSeek Harness permission catalog exceeded its bound",
      );
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "string" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return;
    }
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) {
      throw permissionError(
        "protocolError",
        "DeepSeek Harness returned invalid permission catalog data",
      );
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
    } else {
      if (!isPlainRecord(candidate)) {
        throw permissionError(
          "protocolError",
          "DeepSeek Harness returned invalid permission catalog data",
        );
      }
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== "string") {
          throw permissionError(
            "protocolError",
            "DeepSeek Harness returned invalid permission catalog data",
          );
        }
        visit(candidate[key], depth + 1);
      }
    }
    seen.delete(candidate);
  };
  visit(value, 0);
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned invalid permission catalog data",
    );
  }
  if (text === undefined) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned invalid permission catalog data",
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) {
    throw permissionError(
      "limitExceeded",
      "DeepSeek Harness permission catalog exceeded its byte bound",
    );
  }
}

function nonBlankString(value: unknown, maximum: number, area: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw permissionError("protocolError", `DeepSeek Harness returned an invalid ${area}`);
  }
  return value;
}

function presetOptions(value: unknown, area: string): HarnessPermissionMode[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw permissionError("protocolError", `DeepSeek Harness returned invalid permission ${area}`);
  }
  if (value.length > HARNESS_PERMISSION_MODE_CATALOG_MAX_LENGTH) {
    throw permissionError(
      "limitExceeded",
      `DeepSeek Harness permission ${area} exceeded their bound`,
    );
  }
  const modes = value.map((candidate): HarnessPermissionMode => {
    if (!isPlainRecord(candidate) || !exactKeys(candidate, ["value", "name"], ["description"])) {
      throw permissionError(
        "protocolError",
        "DeepSeek Harness returned an invalid permission option",
      );
    }
    const id = harnessPermissionModeIdSchema.safeParse(candidate.value);
    if (!id.success) {
      throw permissionError(
        "protocolError",
        "DeepSeek Harness returned an invalid permission option id",
      );
    }
    if (id.data === CUSTOM_PERMISSION_MODE_ID) {
      throw permissionError(
        "protocolError",
        "DeepSeek Harness advertised the reserved custom permission",
      );
    }
    const label = nonBlankString(
      candidate.name,
      HARNESS_PERMISSION_MODE_LABEL_MAX_LENGTH,
      "permission label",
    );
    const description = candidate.description;
    if (
      description !== undefined &&
      (typeof description !== "string" ||
        description.length > HARNESS_PERMISSION_MODE_DESCRIPTION_MAX_LENGTH)
    ) {
      throw permissionError(
        "protocolError",
        "DeepSeek Harness returned an invalid permission option description",
      );
    }
    return {
      id: id.data,
      label,
      ...(description?.trim() ? { description } : {}),
    };
  });
  if (new Set(modes.map(({ id }) => id)).size !== modes.length) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned duplicate permission choices",
    );
  }
  return modes;
}

/**
 * Strictly parse the `permissionPresets/catalog` value. `options`
 * lists every selectable preset, including a live `auto`; `defaultOptions`
 * lists the configured presets eligible as the default.
 */
export function parseModernPermissionPresetCatalog(value: unknown): HarnessPermissionModeCatalog {
  assertBoundedJson(value);
  if (!isPlainRecord(value) || !exactKeys(value, ["options", "defaultOptions", "defaultPreset"])) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned an invalid permission catalog",
    );
  }
  const modes = presetOptions(value.options, "options");
  const defaults = presetOptions(value.defaultOptions, "default options");
  if (
    defaults.some(
      (preset) =>
        !modes.some(
          ({ id, label, description }) =>
            id === preset.id && label === preset.label && description === preset.description,
        ),
    )
  ) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness permission defaults disagree with its selectable presets",
    );
  }
  const defaultModeId = harnessPermissionModeIdSchema.safeParse(value.defaultPreset);
  if (!defaultModeId.success || !defaults.some(({ id }) => id === defaultModeId.data)) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned an invalid permission default",
    );
  }
  try {
    return harnessPermissionModeCatalogSchema.parse({ modes, defaultModeId: defaultModeId.data });
  } catch {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned an unusable permission catalog",
    );
  }
}

/** Read the exact no-argument process-level permission catalog. */
export async function loadModernPermissionModeCatalog(
  remote: ModernPermissionModeRemote,
  signal?: AbortSignal,
): Promise<HarnessPermissionModeCatalog | null> {
  const endpoint = PERMISSION_CATALOG_ENDPOINT;
  try {
    const result = await remote.call<unknown>(endpoint, {}, signal);
    if (!result.ok) {
      // A composition without the permission plugin has no catalog Service.
      if (result.error.code === SERVICE_UNAVAILABLE) return null;
      const safe = sanitizeModernRemoteFailure(result.error);
      throw permissionError(
        "remoteError",
        `DeepSeek Harness ${endpoint} failed: ${safe.message}`,
        safe.code,
      );
    }
    return parseModernPermissionPresetCatalog(result.value);
  } catch (error) {
    if (error instanceof ModernPermissionModeError) throw error;
    if (error instanceof ModernRemoteConnectionError) throw connectionError(error, endpoint);
    const code =
      typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    throw permissionError(
      code === "cancelled" ? "cancelled" : "unavailable",
      `DeepSeek Harness ${endpoint} request failed`,
    );
  }
}

/**
 * The `permissions` projection holds only the current value; its options come
 * from the process catalog. `auto` may be current without being in an earlier
 * catalog read.
 */
function parseCurrentPermission(
  value: unknown,
  catalog: HarnessPermissionModeCatalog,
): HarnessPermissionModeId {
  if (!isPlainRecord(value) || !exactKeys(value, ["currentValue"])) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned an invalid permissions projection",
    );
  }
  const current = harnessPermissionModeIdSchema.safeParse(value.currentValue);
  if (!current.success) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned an invalid current permission",
    );
  }
  if (
    current.data !== CUSTOM_PERMISSION_MODE_ID &&
    current.data !== AUTO_PERMISSION_MODE_ID &&
    !catalog.modes.some(({ id }) => id === current.data)
  ) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned an unknown current permission",
    );
  }
  return current.data;
}

/** Read one control-store row without hiding a missing or malformed permission projection. */
export function readModernPermissionModeState(
  row: ModernProjectionRow | undefined,
  catalog: HarnessPermissionModeCatalog | null,
): ModernPermissionModeState | undefined {
  if (!catalog) {
    if (row) {
      throw permissionError(
        "protocolError",
        "DeepSeek Harness exposed permissions without a permission catalog",
      );
    }
    return undefined;
  }
  if (!row) {
    throw permissionError("protocolError", "DeepSeek Harness permissions projection is missing");
  }
  if (!Number.isSafeInteger(row.seq) || row.seq < -1 || Object.is(row.seq, -0)) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness permissions projection has an invalid sequence",
    );
  }
  return {
    permissionModeId: parseCurrentPermission(row.value, catalog),
    projectionSeq: row.seq,
  };
}

/** Exact value predicate for `ModernControlStore.waitFor`; malformed values throw closed. */
export function isModernPermissionModeProjectionMatch(
  value: unknown,
  catalog: HarnessPermissionModeCatalog,
  expectedPermissionModeId: HarnessPermissionModeId,
): boolean {
  const expected = harnessPermissionModeIdSchema.safeParse(expectedPermissionModeId);
  if (!expected.success || !catalog.modes.some(({ id }) => id === expected.data)) {
    throw new TypeError("expectedPermissionModeId is not in the permission catalog");
  }
  return parseCurrentPermission(value, catalog) === expected.data;
}
