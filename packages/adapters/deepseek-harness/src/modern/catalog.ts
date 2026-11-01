import { Buffer } from "node:buffer";

import {
  HARNESS_MODEL_LABEL_MAX_LENGTH,
  harnessThinkingOptionIdSchema,
  type HarnessModelCatalog,
} from "@codexhost/shared-contracts";

import {
  normalizeDeepSeekModelCatalog,
  type DeepSeekModelProviderGroup,
  type DeepSeekModelSelection,
} from "../model-catalog.js";
import { ModernRemoteConnectionError } from "./remote-connection.js";
import {
  redactModernCredential,
  sanitizeModernRemoteFailure,
  type ModernRemoteResult,
} from "./wire.js";

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_DEPTH = 16;
const MAX_CATALOG_NODES = 100_000;
const MAX_PROVIDERS = 256;
const MAX_MODELS = 4_096;
const MAX_EFFORTS_PER_MODEL = 128;
const MAX_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 64 * 1024;

export type ModernModelCatalogErrorCode =
  | "authenticationRequired"
  | "cancelled"
  | "limitExceeded"
  | "notInstalled"
  | "processExited"
  | "protocolError"
  | "remoteError"
  | "unavailable";

export class ModernModelCatalogError extends Error {
  readonly nativeCode?: string;

  constructor(
    readonly code: ModernModelCatalogErrorCode,
    message: string,
    nativeCode?: string,
  ) {
    super(redactModernCredential(message));
    this.name = "ModernModelCatalogError";
    if (nativeCode !== undefined) this.nativeCode = redactModernCredential(nativeCode);
  }
}

export interface ModernModelCatalogRemote {
  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ModernRemoteResult<T>>;
}

/** Validated Modern catalog facts needed by inspection and Session configuration. */
export interface ModernModelCatalogSnapshot {
  readonly catalog: HarnessModelCatalog;
  readonly defaultSelection: DeepSeekModelSelection;
  readonly routableProviders: readonly string[];
  readonly groups: readonly DeepSeekModelProviderGroup[];
}

function catalogError(
  code: ModernModelCatalogErrorCode,
  message: string,
  nativeCode?: string,
): ModernModelCatalogError {
  return new ModernModelCatalogError(code, message, nativeCode);
}

function connectionError(error: ModernRemoteConnectionError): ModernModelCatalogError {
  return catalogError(
    error.code,
    `DeepSeek Harness session/modelCatalog request failed: ${error.message}`,
    error.nativeCode,
  );
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
      throw catalogError("limitExceeded", "DeepSeek Harness model catalog exceeded its bound");
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
      throw catalogError("protocolError", "DeepSeek Harness returned an invalid model catalog");
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
    } else {
      if (!isPlainRecord(candidate)) {
        throw catalogError("protocolError", "DeepSeek Harness returned an invalid model catalog");
      }
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== "string") {
          throw catalogError("protocolError", "DeepSeek Harness returned an invalid model catalog");
        }
        visit(candidate[key], depth + 1);
      }
    }
    seen.delete(candidate);
  };
  visit(value, 0);
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw catalogError("protocolError", "DeepSeek Harness returned an invalid model catalog");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) {
    throw catalogError("limitExceeded", "DeepSeek Harness model catalog exceeded its byte bound");
  }
}

function boundedString(value: unknown, maximum: number, area: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!allowEmpty && value.trim().length === 0) ||
    /[\u0000]/u.test(value)
  ) {
    throw catalogError("protocolError", `DeepSeek Harness returned an invalid ${area}`);
  }
  return value;
}

function array(value: unknown, maximum: number, area: string): unknown[] {
  if (!Array.isArray(value)) {
    throw catalogError("protocolError", `DeepSeek Harness returned an invalid ${area}`);
  }
  if (value.length > maximum) {
    throw catalogError("limitExceeded", `DeepSeek Harness ${area} exceeded its item bound`);
  }
  return value;
}

function selection(value: unknown): DeepSeekModelSelection {
  if (!isPlainRecord(value) || !exactKeys(value, ["provider", "model"], ["reasoningEffort"])) {
    throw catalogError("protocolError", "DeepSeek Harness returned an invalid default Model");
  }
  return {
    provider: boundedString(value.provider, MAX_ID_LENGTH, "default Model provider"),
    model: boundedString(value.model, MAX_ID_LENGTH, "default Model id"),
    ...(value.reasoningEffort === undefined
      ? {}
      : {
          reasoningEffort: boundedString(
            value.reasoningEffort,
            MAX_ID_LENGTH,
            "default reasoning effort",
          ),
        }),
  };
}

function reasoning(
  value: unknown,
): NonNullable<DeepSeekModelProviderGroup["models"][number]["reasoning"]> {
  if (!isPlainRecord(value) || !exactKeys(value, ["efforts"], ["defaultEffort"])) {
    throw catalogError("protocolError", "DeepSeek Harness returned invalid Model reasoning");
  }
  const efforts = array(value.efforts, MAX_EFFORTS_PER_MODEL, "reasoning effort list").map(
    (candidate) => {
      if (!isPlainRecord(candidate) || !exactKeys(candidate, ["id", "name"], ["description"])) {
        throw catalogError(
          "protocolError",
          "DeepSeek Harness returned an invalid reasoning effort",
        );
      }
      const id = boundedString(candidate.id, MAX_ID_LENGTH, "reasoning effort id");
      if (!harnessThinkingOptionIdSchema.safeParse(id).success) {
        throw catalogError(
          "protocolError",
          "DeepSeek Harness returned an unusable reasoning effort id",
        );
      }
      return {
        id,
        name: boundedString(candidate.name, MAX_NAME_LENGTH, "reasoning effort name"),
        ...(candidate.description === undefined
          ? {}
          : {
              description: boundedString(
                candidate.description,
                MAX_DESCRIPTION_LENGTH,
                "reasoning effort description",
                true,
              ),
            }),
      };
    },
  );
  const ids = efforts.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw catalogError("protocolError", "DeepSeek Harness returned duplicate reasoning efforts");
  }
  const defaultEffort =
    value.defaultEffort === undefined
      ? undefined
      : boundedString(value.defaultEffort, MAX_ID_LENGTH, "default reasoning effort");
  if (defaultEffort !== undefined && !ids.includes(defaultEffort)) {
    throw catalogError(
      "protocolError",
      "DeepSeek Harness returned an unknown default reasoning effort",
    );
  }
  return { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) };
}

function groups(value: unknown, routable: ReadonlySet<string>): DeepSeekModelProviderGroup[] {
  let modelCount = 0;
  const parsed = array(value, MAX_PROVIDERS, "Model provider group list").map((candidate) => {
    if (!isPlainRecord(candidate) || !exactKeys(candidate, ["id", "name", "models"])) {
      throw catalogError(
        "protocolError",
        "DeepSeek Harness returned an invalid Model provider group",
      );
    }
    const id = boundedString(candidate.id, MAX_ID_LENGTH, "Model provider id");
    if (!routable.has(id)) {
      throw catalogError("protocolError", "DeepSeek Harness returned a non-routable Model group");
    }
    const name = boundedString(candidate.name, MAX_NAME_LENGTH, "Model provider name");
    const models = array(candidate.models, MAX_MODELS, "Model list").map((model) => {
      modelCount += 1;
      if (modelCount > MAX_MODELS) {
        throw catalogError("limitExceeded", "DeepSeek Harness Model list exceeded its item bound");
      }
      if (
        !isPlainRecord(model) ||
        !exactKeys(model, ["id", "name"], ["description", "reasoning"])
      ) {
        throw catalogError("protocolError", "DeepSeek Harness returned an invalid Model");
      }
      const modelId = boundedString(model.id, MAX_ID_LENGTH, "Model id");
      const modelName = boundedString(model.name, MAX_NAME_LENGTH, "Model name");
      if (`${name} / ${modelName}`.length > HARNESS_MODEL_LABEL_MAX_LENGTH) {
        throw catalogError(
          "protocolError",
          "DeepSeek Harness returned a Model label that is too long",
        );
      }
      return {
        id: modelId,
        name: modelName,
        ...(model.description === undefined
          ? {}
          : {
              description: boundedString(
                model.description,
                MAX_DESCRIPTION_LENGTH,
                "Model description",
                true,
              ),
            }),
        ...(model.reasoning === undefined ? {} : { reasoning: reasoning(model.reasoning) }),
      };
    });
    if (models.length === 0) {
      throw catalogError(
        "protocolError",
        "DeepSeek Harness returned an empty Model provider group",
      );
    }
    const modelIds = models.map((model) => model.id);
    if (new Set(modelIds).size !== modelIds.length) {
      throw catalogError("protocolError", "DeepSeek Harness returned duplicate Model ids");
    }
    return { id, name, models };
  });
  const ids = parsed.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw catalogError(
      "protocolError",
      "DeepSeek Harness returned duplicate Model provider groups",
    );
  }
  return parsed;
}

function validateFailures(
  value: unknown,
  routable: ReadonlySet<string>,
  successful: ReadonlySet<string>,
): void {
  const ids: string[] = [];
  for (const candidate of array(value, MAX_PROVIDERS, "Model provider failure list")) {
    if (!isPlainRecord(candidate) || !exactKeys(candidate, ["id", "name", "message"])) {
      throw catalogError("protocolError", "DeepSeek Harness returned an invalid provider failure");
    }
    const id = boundedString(candidate.id, MAX_ID_LENGTH, "failed provider id");
    boundedString(candidate.name, MAX_NAME_LENGTH, "failed provider name");
    boundedString(candidate.message, MAX_DESCRIPTION_LENGTH, "provider failure message", true);
    if (!routable.has(id) || successful.has(id)) {
      throw catalogError(
        "protocolError",
        "DeepSeek Harness returned an inconsistent provider failure",
      );
    }
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) {
    throw catalogError("protocolError", "DeepSeek Harness returned duplicate provider failures");
  }
}

/** Strictly parse one successful Modern `session/modelCatalog` value. */
export function parseModernModelCatalog(value: unknown): ModernModelCatalogSnapshot {
  assertBoundedJson(value);
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, ["default", "routableProviders", "groups", "failures"])
  ) {
    throw catalogError("protocolError", "DeepSeek Harness returned an invalid model catalog");
  }
  const defaultSelection = selection(value.default);
  const routableProviders = array(
    value.routableProviders,
    MAX_PROVIDERS,
    "routable provider list",
  ).map((candidate) => boundedString(candidate, MAX_ID_LENGTH, "routable provider id"));
  if (new Set(routableProviders).size !== routableProviders.length) {
    throw catalogError("protocolError", "DeepSeek Harness returned duplicate routable providers");
  }
  const routable = new Set(routableProviders);
  const parsedGroups = groups(value.groups, routable);
  validateFailures(value.failures, routable, new Set(parsedGroups.map(({ id }) => id)));

  let catalog: HarnessModelCatalog;
  try {
    catalog = normalizeDeepSeekModelCatalog(
      parsedGroups,
      routable.has(defaultSelection.provider) ? defaultSelection : undefined,
    );
  } catch {
    throw catalogError("protocolError", "DeepSeek Harness returned an unusable model catalog");
  }
  return {
    catalog,
    defaultSelection,
    routableProviders,
    groups: parsedGroups,
  };
}

/** Read the exact no-argument Modern Model catalog endpoint. */
export async function loadModernModelCatalog(
  remote: ModernModelCatalogRemote,
  signal?: AbortSignal,
): Promise<ModernModelCatalogSnapshot> {
  try {
    const result = await remote.call<unknown>("session/modelCatalog", {}, signal);
    if (!result.ok) {
      const safe = sanitizeModernRemoteFailure(result.error);
      throw catalogError(
        "remoteError",
        `DeepSeek Harness session/modelCatalog failed: ${safe.message}`,
        safe.code,
      );
    }
    return parseModernModelCatalog(result.value);
  } catch (error) {
    if (error instanceof ModernModelCatalogError) throw error;
    if (error instanceof ModernRemoteConnectionError) throw connectionError(error);
    const code =
      typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    throw catalogError(
      code === "cancelled" ? "cancelled" : "unavailable",
      "DeepSeek Harness session/modelCatalog request failed",
    );
  }
}
