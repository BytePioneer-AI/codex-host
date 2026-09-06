import { Buffer } from "node:buffer";

import Schema from "@deepseek-ai/schemastery";

import {
  HARNESS_PERMISSION_MODE_CATALOG_MAX_LENGTH,
  HARNESS_PERMISSION_MODE_DESCRIPTION_MAX_LENGTH,
  HARNESS_PERMISSION_MODE_LABEL_MAX_LENGTH,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
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

const PERMISSION_NAMESPACE = "permission";
const CUSTOM_PERMISSION_MODE_ID = "custom";
const MAX_SETTINGS_BYTES = 16 * 1024 * 1024;
const MAX_SETTINGS_DEPTH = 64;
const MAX_SETTINGS_NODES = 200_000;
const MAX_NAMESPACES = 512;
const MAX_NAMESPACE_ID_LENGTH = 256;
const MAX_SECRETS_PER_NAMESPACE = 1_024;
const MAX_SECRET_PATH_SEGMENTS = 64;

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

function connectionError(error: ModernRemoteConnectionError): ModernPermissionModeError {
  return permissionError(
    error.code,
    `DeepSeek Harness settings/describe request failed: ${error.message}`,
    error.nativeCode,
  );
}

interface PermissionNamespaceView {
  readonly schema: unknown;
  readonly value: unknown;
  readonly base?: unknown;
  readonly user?: unknown;
  readonly applies: "live" | "restart";
  readonly secrets: readonly unknown[];
}

interface SchemaNode {
  readonly type?: unknown;
  readonly value?: unknown;
  readonly list?: unknown;
  readonly dict?: Record<string, SchemaNode>;
  readonly meta?: {
    readonly required?: unknown;
    readonly description?: unknown;
  };
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
    if (depth > MAX_SETTINGS_DEPTH || nodes > MAX_SETTINGS_NODES) {
      throw permissionError(
        "limitExceeded",
        "DeepSeek Harness settings response exceeded its bound",
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
      throw permissionError("protocolError", "DeepSeek Harness returned invalid settings data");
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
    } else {
      if (!isPlainRecord(candidate)) {
        throw permissionError("protocolError", "DeepSeek Harness returned invalid settings data");
      }
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== "string") {
          throw permissionError("protocolError", "DeepSeek Harness returned invalid settings data");
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
    throw permissionError("protocolError", "DeepSeek Harness returned invalid settings data");
  }
  if (text === undefined) {
    throw permissionError("protocolError", "DeepSeek Harness returned invalid settings data");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SETTINGS_BYTES) {
    throw permissionError(
      "limitExceeded",
      "DeepSeek Harness settings response exceeded its byte bound",
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

function validRevision(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

function validateSecrets(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw permissionError("protocolError", "DeepSeek Harness returned invalid settings secrets");
  }
  if (value.length > MAX_SECRETS_PER_NAMESPACE) {
    throw permissionError(
      "limitExceeded",
      "DeepSeek Harness settings secrets exceeded their bound",
    );
  }
  for (const secret of value) {
    if (
      !isPlainRecord(secret) ||
      !exactKeys(secret, ["path", "set"]) ||
      !Array.isArray(secret.path) ||
      secret.path.length > MAX_SECRET_PATH_SEGMENTS ||
      typeof secret.set !== "boolean"
    ) {
      throw permissionError("protocolError", "DeepSeek Harness returned invalid settings secrets");
    }
    for (const segment of secret.path) {
      if (typeof segment !== "string") {
        throw permissionError(
          "protocolError",
          "DeepSeek Harness returned invalid settings secrets",
        );
      }
    }
  }
  return value;
}

function parseDescribe(value: unknown): PermissionNamespaceView | null {
  assertBoundedJson(value);
  if (!isPlainRecord(value) || !exactKeys(value, ["writable", "hasDocument", "namespaces"])) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned an invalid settings response",
    );
  }
  if (
    typeof value.writable !== "boolean" ||
    typeof value.hasDocument !== "boolean" ||
    !Array.isArray(value.namespaces)
  ) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned an invalid settings response",
    );
  }
  if (value.namespaces.length > MAX_NAMESPACES) {
    throw permissionError(
      "limitExceeded",
      "DeepSeek Harness settings namespaces exceeded their bound",
    );
  }

  const namespaceIds: string[] = [];
  const permissionNamespaces: PermissionNamespaceView[] = [];
  for (const candidate of value.namespaces) {
    if (
      !isPlainRecord(candidate) ||
      !exactKeys(
        candidate,
        ["ns", "schema", "value", "applies", "secrets", "revision"],
        ["base", "user"],
      ) ||
      (candidate.applies !== "live" && candidate.applies !== "restart") ||
      !validRevision(candidate.revision)
    ) {
      throw permissionError(
        "protocolError",
        "DeepSeek Harness returned an invalid settings namespace",
      );
    }
    const ns = nonBlankString(candidate.ns, MAX_NAMESPACE_ID_LENGTH, "settings namespace id");
    const secrets = validateSecrets(candidate.secrets);
    namespaceIds.push(ns);
    if (ns === PERMISSION_NAMESPACE) {
      permissionNamespaces.push({
        schema: candidate.schema,
        value: candidate.value,
        ...(Object.hasOwn(candidate, "base") ? { base: candidate.base } : {}),
        ...(Object.hasOwn(candidate, "user") ? { user: candidate.user } : {}),
        applies: candidate.applies,
        secrets,
      });
    }
  }
  if (new Set(namespaceIds).size !== namespaceIds.length) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned duplicate settings namespaces",
    );
  }
  if (permissionNamespaces.length === 0) return null;
  if (permissionNamespaces.length !== 1) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned duplicate permission namespaces",
    );
  }
  return permissionNamespaces[0] as PermissionNamespaceView;
}

function permissionSection(
  value: unknown,
  requireDefault: boolean,
  knownIds: ReadonlySet<string>,
  area: string,
): void {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, requireDefault ? ["defaultPreset"] : [], ["defaultPreset"])
  ) {
    throw permissionError("protocolError", `DeepSeek Harness returned invalid permission ${area}`);
  }
  if (value.defaultPreset !== undefined) {
    const id = harnessPermissionModeIdSchema.safeParse(value.defaultPreset);
    if (!id.success || !knownIds.has(id.data)) {
      throw permissionError(
        "protocolError",
        `DeepSeek Harness returned invalid permission ${area}`,
      );
    }
  }
}

function catalogFromNamespace(view: PermissionNamespaceView): HarnessPermissionModeCatalog {
  if (view.applies !== "live") {
    throw permissionError("protocolError", "DeepSeek Harness permission settings are not live");
  }
  if (view.secrets.length !== 0) {
    throw permissionError("protocolError", "DeepSeek Harness permission settings declared secrets");
  }

  let root: SchemaNode;
  try {
    root = new Schema(view.schema as never) as unknown as SchemaNode;
  } catch {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned an invalid permission schema",
    );
  }
  const dictionary = root.type === "object" ? root.dict : undefined;
  if (
    !dictionary ||
    Object.keys(dictionary).length !== 1 ||
    !Object.hasOwn(dictionary, "defaultPreset")
  ) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned an invalid permission schema",
    );
  }
  const field = dictionary.defaultPreset as SchemaNode;
  if (field.meta?.required !== true) {
    throw permissionError("protocolError", "DeepSeek Harness permission default is not required");
  }
  const choices =
    field.type === "union" ? field.list : field.type === "const" ? [field] : undefined;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness permission schema has no preset choices",
    );
  }
  if (choices.length > HARNESS_PERMISSION_MODE_CATALOG_MAX_LENGTH) {
    throw permissionError(
      "limitExceeded",
      "DeepSeek Harness permission choices exceeded their bound",
    );
  }

  const modes = choices.map((candidate) => {
    const choice = candidate as SchemaNode;
    const parsedId = harnessPermissionModeIdSchema.safeParse(choice.value);
    if (choice.type !== "const" || !parsedId.success) {
      throw permissionError(
        "protocolError",
        "DeepSeek Harness returned an invalid permission choice",
      );
    }
    if (parsedId.data === CUSTOM_PERMISSION_MODE_ID) {
      throw permissionError(
        "protocolError",
        "DeepSeek Harness advertised the reserved custom permission",
      );
    }
    const described = choice.meta?.description;
    if (described !== undefined && typeof described !== "string") {
      throw permissionError(
        "protocolError",
        "DeepSeek Harness returned an invalid permission label",
      );
    }
    const label = described ?? parsedId.data;
    nonBlankString(label, HARNESS_PERMISSION_MODE_LABEL_MAX_LENGTH, "permission label");
    return { id: parsedId.data, label };
  });
  const ids = modes.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned duplicate permission choices",
    );
  }
  const knownIds = new Set(ids);
  permissionSection(view.value, true, knownIds, "value");
  if (view.base !== undefined) permissionSection(view.base, false, knownIds, "base");
  if (view.user !== undefined) permissionSection(view.user, false, knownIds, "user section");
  const defaultModeId = (view.value as { readonly defaultPreset: HarnessPermissionModeId })
    .defaultPreset;
  try {
    return harnessPermissionModeCatalogSchema.parse({ modes, defaultModeId });
  } catch {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned an unusable permission catalog",
    );
  }
}

/** Strictly parse the Modern `settings/describe` value and its optional permission namespace. */
export function parseModernPermissionModeCatalog(
  value: unknown,
): HarnessPermissionModeCatalog | null {
  const permission = parseDescribe(value);
  return permission ? catalogFromNamespace(permission) : null;
}

/** Read the exact no-argument Modern settings endpoint. */
export async function loadModernPermissionModeCatalog(
  remote: ModernPermissionModeRemote,
  signal?: AbortSignal,
): Promise<HarnessPermissionModeCatalog | null> {
  try {
    const result = await remote.call<unknown>("settings/describe", {}, signal);
    if (!result.ok) {
      const safe = sanitizeModernRemoteFailure(result.error);
      throw permissionError(
        "remoteError",
        `DeepSeek Harness settings/describe failed: ${safe.message}`,
        safe.code,
      );
    }
    return parseModernPermissionModeCatalog(result.value);
  } catch (error) {
    if (error instanceof ModernPermissionModeError) throw error;
    if (error instanceof ModernRemoteConnectionError) throw connectionError(error);
    const code =
      typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    throw permissionError(
      code === "cancelled" ? "cancelled" : "unavailable",
      "DeepSeek Harness settings/describe request failed",
    );
  }
}

function parseProjectionValue(
  value: unknown,
  catalog: HarnessPermissionModeCatalog,
): HarnessPermissionModeId {
  if (!isPlainRecord(value) || !exactKeys(value, ["options", "currentValue"])) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned an invalid permissions projection",
    );
  }
  if (
    !Array.isArray(value.options) ||
    value.options.length > HARNESS_PERMISSION_MODE_CATALOG_MAX_LENGTH + 1
  ) {
    throw permissionError("protocolError", "DeepSeek Harness returned invalid permission options");
  }
  const options = value.options.map((candidate) => {
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
    nonBlankString(
      candidate.name,
      HARNESS_PERMISSION_MODE_LABEL_MAX_LENGTH,
      "permission option name",
    );
    if (
      candidate.description !== undefined &&
      (typeof candidate.description !== "string" ||
        candidate.description.length > HARNESS_PERMISSION_MODE_DESCRIPTION_MAX_LENGTH)
    ) {
      throw permissionError(
        "protocolError",
        "DeepSeek Harness returned an invalid permission option description",
      );
    }
    return { id: id.data, name: candidate.name };
  });
  const ids = options.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned duplicate permission options",
    );
  }

  const current = harnessPermissionModeIdSchema.safeParse(value.currentValue);
  if (!current.success) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned an invalid current permission",
    );
  }
  const customIndex = ids.indexOf(CUSTOM_PERMISSION_MODE_ID as HarnessPermissionModeId);
  if (
    customIndex >= 0 &&
    (customIndex !== ids.length - 1 || current.data !== CUSTOM_PERMISSION_MODE_ID)
  ) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness returned an invalid custom permission state",
    );
  }
  if (current.data === CUSTOM_PERMISSION_MODE_ID && customIndex < 0) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness omitted its current custom permission",
    );
  }
  const selectable = options.filter(({ id }) => id !== CUSTOM_PERMISSION_MODE_ID);
  const expected = catalog.modes.map(({ id }) => id);
  if (
    selectable.length !== expected.length ||
    selectable.some(
      ({ id, name }, index) => id !== expected[index] || name !== catalog.modes[index]?.label,
    )
  ) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness permissions projection disagrees with its settings catalog",
    );
  }
  if (current.data !== CUSTOM_PERMISSION_MODE_ID && !expected.includes(current.data)) {
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
        "DeepSeek Harness exposed permissions without a settings catalog",
      );
    }
    return undefined;
  }
  if (!row) {
    throw permissionError("protocolError", "DeepSeek Harness permissions projection is missing");
  }
  if (!Number.isSafeInteger(row.seq) || row.seq < 0 || Object.is(row.seq, -0)) {
    throw permissionError(
      "protocolError",
      "DeepSeek Harness permissions projection has an invalid sequence",
    );
  }
  return {
    permissionModeId: parseProjectionValue(row.value, catalog),
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
  return parseProjectionValue(value, catalog) === expected.data;
}
