import { type HarnessError, type HarnessSessionState } from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelRef,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import {
  decodeDeepSeekHarnessModelRef,
  encodeDeepSeekHarnessModelRef,
  normalizeDeepSeekThinkingOptions,
  type DeepSeekModelSelection,
} from "../model-catalog.js";
import type { ModernModelCatalogSnapshot } from "./catalog.js";
import { executeModernCommand, ModernCommandError, type ModernCommandRemote } from "./commands.js";
import {
  type ModernControlJsonValue,
  type ModernControlStore,
  ModernControlStoreError,
  type ModernProjectionRow,
} from "./control-store.js";
import {
  isModernPermissionModeProjectionMatch,
  ModernPermissionModeError,
  readModernPermissionModeState,
} from "./permission-modes.js";
import { ModernRemoteConnectionError } from "./remote-connection.js";
import {
  redactModernCredential,
  sanitizeModernRemoteFailure,
  type ModernRemoteResult,
} from "./wire.js";

export const MODERN_MODEL_SELECTION_PROJECTION_KEY = "modelSelection";
export const MODERN_PERMISSION_PROJECTION_KEY = "permissions";

const MAX_SELECTION_ID_LENGTH = 512;

export type ModernConfigurationErrorCode =
  | "authenticationRequired"
  | "cancelled"
  | "invalidRequest"
  | "limitExceeded"
  | "notInstalled"
  | "processExited"
  | "protocolError"
  | "remoteError"
  | "unsupported"
  | "unavailable";

export class ModernConfigurationError extends Error {
  readonly nativeCode?: string;

  constructor(
    readonly code: ModernConfigurationErrorCode,
    message: string,
    nativeCode?: string,
  ) {
    super(redactModernCredential(message));
    this.name = "ModernConfigurationError";
    if (nativeCode !== undefined) this.nativeCode = redactModernCredential(nativeCode);
  }
}

export type ModernConfigurationRemote = ModernCommandRemote;

export interface ModernConfigurationControl {
  snapshot(sessionId: string): Readonly<Record<string, ModernProjectionRow>> | undefined;
  waitFor(
    sessionId: string,
    key: string,
    afterSeq: number,
    predicate: (value: ModernControlJsonValue) => boolean,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<ModernProjectionRow>;
}

export interface ModernModelSelectionState {
  readonly selection: DeepSeekModelSelection;
  readonly projectionSeq: number;
  /** Whether next/lastUsed, rather than the mutable global default, owns this value. */
  readonly explicit: boolean;
}

export interface ModernConfigurationSnapshot {
  readonly state: HarnessSessionState;
  readonly model: ModernModelSelectionState;
  readonly permissionProjectionSeq?: number;
}

export interface ModernSelectionResult extends ModernModelSelectionState {
  readonly changed: boolean;
}

function configurationError(
  code: ModernConfigurationErrorCode,
  message: string,
  nativeCode?: string,
): ModernConfigurationError {
  return new ModernConfigurationError(code, message, nativeCode);
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

function boundedSelectionString(value: unknown, area: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_SELECTION_ID_LENGTH ||
    value.includes("\0")
  ) {
    throw configurationError("protocolError", `DeepSeek Harness returned an invalid ${area}`);
  }
  return value;
}

function parseSelection(value: unknown, area: string): DeepSeekModelSelection {
  if (!isPlainRecord(value) || !exactKeys(value, ["provider", "model"], ["reasoningEffort"])) {
    throw configurationError("protocolError", `DeepSeek Harness returned an invalid ${area}`);
  }
  const provider = boundedSelectionString(value.provider, `${area} provider`);
  const model = boundedSelectionString(value.model, `${area} Model`);
  if (value.reasoningEffort === undefined) return { provider, model };
  const effort = harnessThinkingOptionIdSchema.safeParse(value.reasoningEffort);
  if (!effort.success) {
    throw configurationError(
      "protocolError",
      `DeepSeek Harness returned an invalid ${area} reasoning effort`,
    );
  }
  return { provider, model, reasoningEffort: effort.data };
}

function parseOptionalSelection(value: unknown, area: string): DeepSeekModelSelection | null {
  return value === null ? null : parseSelection(value, area);
}

function validSeq(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= -1 && !Object.is(value, -0)
  );
}

function sameSelection(left: DeepSeekModelSelection, right: DeepSeekModelSelection): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort
  );
}

function parseProjectionSelection(value: unknown): DeepSeekModelSelection | null {
  if (!isPlainRecord(value) || !exactKeys(value, ["lastUsed", "next"])) {
    throw configurationError(
      "protocolError",
      "DeepSeek Harness returned an invalid modelSelection projection",
    );
  }
  const lastUsed = parseOptionalSelection(value.lastUsed, "last-used Model selection");
  const next = parseOptionalSelection(value.next, "next Model selection");
  return next ?? lastUsed;
}

/** Strictly read Modern DSH's authoritative modelSelection control row. */
export function readModernModelSelectionState(
  row: ModernProjectionRow | undefined,
  catalog: ModernModelCatalogSnapshot,
): ModernModelSelectionState {
  if (!row) {
    throw configurationError(
      "protocolError",
      "DeepSeek Harness modelSelection projection is missing",
    );
  }
  if (!validSeq(row.seq)) {
    throw configurationError(
      "protocolError",
      "DeepSeek Harness modelSelection projection has an invalid sequence",
    );
  }
  const projected = parseProjectionSelection(row.value);
  const selection =
    projected ?? parseSelection(catalog.defaultSelection, "default Model selection");
  try {
    encodeDeepSeekHarnessModelRef(selection);
  } catch {
    throw configurationError(
      "protocolError",
      "DeepSeek Harness modelSelection projection cannot be represented by codexhost",
    );
  }
  return { selection, projectionSeq: row.seq, explicit: projected !== null };
}

function stateForSelection(
  nativeRef: NativeSessionRef,
  selection: DeepSeekModelSelection,
  catalog: ModernModelCatalogSnapshot,
  permissionModeId?: HarnessPermissionModeId,
): HarnessSessionState {
  const effectiveModel = encodeDeepSeekHarnessModelRef(selection);
  if (!catalog.routableProviders.includes(selection.provider)) {
    throw configurationError(
      "protocolError",
      "DeepSeek Harness modelSelection names a non-routable provider",
    );
  }
  const nativeModel = catalog.groups
    .find(({ id }) => id === selection.provider)
    ?.models.find(({ id }) => id === selection.model);
  const catalogModel = nativeModel
    ? catalog.catalog.models.find(({ ref }) => ref.id === effectiveModel.id)
    : undefined;
  const availableThinkingOptions = normalizeDeepSeekThinkingOptions({
    current: selection,
    groups: catalog.groups,
  });
  const effectiveEffort = selection.reasoningEffort ?? nativeModel?.reasoning?.defaultEffort;
  const effectiveThinkingOptionId =
    effectiveEffort === undefined
      ? undefined
      : harnessThinkingOptionIdSchema.parse(effectiveEffort);
  const canPublishThinkingOptions =
    availableThinkingOptions.length > 0 &&
    (!effectiveThinkingOptionId ||
      availableThinkingOptions.some(({ id }) => id === effectiveThinkingOptionId));
  return {
    nativeRef,
    effectiveModel,
    ...(catalogModel ? { resolvedModelLabel: catalogModel.label } : {}),
    ...(effectiveThinkingOptionId ? { effectiveThinkingOptionId } : {}),
    ...(canPublishThinkingOptions ? { availableThinkingOptions } : {}),
    ...(permissionModeId ? { effectivePermissionModeId: permissionModeId } : {}),
  };
}

/** Merge both authoritative control rows with the immutable discovery catalogs. */
export function readModernConfigurationSnapshot(input: {
  readonly control: Pick<ModernControlStore, "snapshot">;
  readonly sessionId: string;
  readonly nativeRef: NativeSessionRef;
  readonly modelCatalog: ModernModelCatalogSnapshot;
  readonly permissionModes: HarnessPermissionModeCatalog | null;
}): ModernConfigurationSnapshot {
  const rows = input.control.snapshot(input.sessionId);
  if (!rows) {
    throw configurationError("protocolError", "DeepSeek Harness control state is detached");
  }
  const model = readModernModelSelectionState(
    rows[MODERN_MODEL_SELECTION_PROJECTION_KEY],
    input.modelCatalog,
  );
  const permission = readModernPermissionModeState(
    rows[MODERN_PERMISSION_PROJECTION_KEY],
    input.permissionModes,
  );
  return {
    model,
    state: stateForSelection(
      input.nativeRef,
      model.selection,
      input.modelCatalog,
      permission?.permissionModeId,
    ),
    ...(permission ? { permissionProjectionSeq: permission.projectionSeq } : {}),
  };
}

/** Convert one public Model ref plus optional Thinking override into a complete Modern selection. */
export function modernSelectionForModel(
  catalog: ModernModelCatalogSnapshot,
  model: HarnessModelRef,
  thinkingOptionId?: string,
): DeepSeekModelSelection {
  let native: ReturnType<typeof decodeDeepSeekHarnessModelRef>;
  try {
    native = decodeDeepSeekHarnessModelRef(model);
  } catch (error) {
    throw configurationError(
      "invalidRequest",
      error instanceof Error ? error.message : "DeepSeek Harness Model is invalid",
    );
  }
  const catalogModel = catalog.catalog.models.find(({ ref }) => ref.id === model.id);
  if (!catalogModel) {
    throw configurationError("invalidRequest", "DeepSeek Harness Model is unavailable");
  }
  const nativeModel = catalog.groups
    .find(({ id }) => id === native.provider)
    ?.models.find(({ id }) => id === native.model);
  const effort = thinkingOptionId ?? nativeModel?.reasoning?.defaultEffort;
  if (effort !== undefined) {
    const parsed = harnessThinkingOptionIdSchema.safeParse(effort);
    if (!parsed.success || !catalogModel.supportedThinkingOptionIds?.includes(parsed.data)) {
      throw configurationError(
        "invalidRequest",
        "DeepSeek Harness Thinking option is unavailable for the selected Model",
      );
    }
    return { ...native, reasoningEffort: parsed.data };
  }
  return native;
}

/** Apply an exact selection and accept it only after a higher authoritative projection confirms it. */
export async function selectModernModel(
  remote: ModernConfigurationRemote,
  control: ModernConfigurationControl,
  sessionId: string,
  catalog: ModernModelCatalogSnapshot,
  requested: DeepSeekModelSelection,
  signal?: AbortSignal,
  options: {
    readonly allowMissingInitialProjection?: boolean;
  } = {},
): Promise<ModernSelectionResult> {
  const current = await requireModernModelSelectionState(
    control,
    sessionId,
    catalog,
    signal,
    options.allowMissingInitialProjection === true,
  );
  if (current.explicit && sameSelection(current.selection, requested)) {
    return { ...current, changed: false };
  }

  let response: ModernRemoteResult<unknown>;
  try {
    response = await remote.call<unknown>(
      "session/selectModel",
      { request: { sessionId, ...requested } },
      signal,
    );
  } catch (error) {
    if (!isUncertainTransportFailure(error)) {
      throw normalizeConnectionFailure(error, "session/selectModel request failed");
    }
    try {
      const confirmed = await waitForModelSelection(
        control,
        sessionId,
        current.projectionSeq,
        requested,
        signal,
      );
      return { ...readModernModelSelectionState(confirmed, catalog), changed: true };
    } catch (confirmationError) {
      if (confirmationError instanceof ModernConfigurationError) throw confirmationError;
      if (isProjectionProtocolFailure(confirmationError)) {
        throw configurationError("protocolError", confirmationError.message);
      }
      throw normalizeConnectionFailure(error, "session/selectModel request failed");
    }
  }
  if (!response.ok) {
    assertNoModelMutationContradiction(control, sessionId, current.projectionSeq, requested);
    const safe = sanitizeModernRemoteFailure(response.error);
    throw configurationError(
      "remoteError",
      `DeepSeek Harness session/selectModel failed: ${safe.message}`,
      safe.code,
    );
  }
  if (!isPlainRecord(response.value) || !exactKeys(response.value, ["selected"])) {
    throw configurationError(
      "protocolError",
      "DeepSeek Harness session/selectModel returned an invalid selection",
    );
  }
  const selected = parseSelection(response.value.selected, "selected Model");
  if (
    selected.provider !== requested.provider ||
    selected.model !== requested.model ||
    (requested.reasoningEffort !== undefined &&
      selected.reasoningEffort !== requested.reasoningEffort)
  ) {
    throw configurationError(
      "protocolError",
      "DeepSeek Harness session/selectModel returned a different selection",
    );
  }
  const confirmed = await waitForModelSelection(
    control,
    sessionId,
    current.projectionSeq,
    selected,
    signal,
  );
  return { ...readModernModelSelectionState(confirmed, catalog), changed: true };
}

/** Apply one selectable permission preset and require a higher exact control projection. */
export async function selectModernPermissionMode(
  remote: ModernConfigurationRemote,
  control: ModernConfigurationControl,
  sessionId: string,
  catalog: HarnessPermissionModeCatalog | null,
  permissionModeId: HarnessPermissionModeId,
  signal: AbortSignal,
): Promise<{ readonly projectionSeq: number; readonly changed: boolean }> {
  const requested = harnessPermissionModeIdSchema.safeParse(permissionModeId);
  if (!requested.success || !catalog?.modes.some(({ id }) => id === requested.data)) {
    throw configurationError(
      catalog ? "invalidRequest" : "unsupported",
      "DeepSeek Harness Permission Mode is unavailable",
    );
  }
  const current = await requireModernPermissionModeState(control, sessionId, catalog, signal);
  if (current.permissionModeId === requested.data) {
    return { projectionSeq: current.projectionSeq, changed: false };
  }
  const beforeSeq = current.projectionSeq;
  let execution: Awaited<ReturnType<typeof executeModernCommand>>;
  try {
    execution = await executeModernCommand(
      remote,
      sessionId,
      `/permission ${requested.data}`,
      signal,
    );
  } catch (error) {
    if (!isUncertainTransportFailure(error)) {
      if (error instanceof ModernCommandError && error.code === "remoteError") {
        assertNoPermissionMutationContradiction(
          control,
          sessionId,
          beforeSeq,
          catalog,
          requested.data,
        );
      }
      throw normalizeConnectionFailure(error, "commands/execute request failed");
    }
    try {
      const confirmed = await waitForPermissionMode(
        control,
        sessionId,
        beforeSeq,
        catalog,
        requested.data,
        signal,
      );
      return { projectionSeq: confirmed.seq, changed: true };
    } catch (confirmationError) {
      if (confirmationError instanceof ModernConfigurationError) throw confirmationError;
      if (isProjectionProtocolFailure(confirmationError)) {
        throw configurationError("protocolError", confirmationError.message);
      }
      throw normalizeConnectionFailure(error, "commands/execute request failed");
    }
  }
  if (!execution) {
    throw configurationError(
      "protocolError",
      "DeepSeek Harness did not expose its Permission Mode command",
    );
  }
  if (execution.result.kind !== "success") {
    assertNoPermissionMutationContradiction(control, sessionId, beforeSeq, catalog, requested.data);
    throw configurationError("remoteError", execution.result.text, "commands/error");
  }
  const confirmed = await waitForPermissionMode(
    control,
    sessionId,
    beforeSeq,
    catalog,
    requested.data,
    signal,
  );
  return { projectionSeq: confirmed.seq, changed: true };
}

function assertNoModelMutationContradiction(
  control: ModernConfigurationControl,
  sessionId: string,
  beforeSeq: number,
  requested: DeepSeekModelSelection,
): void {
  const row = control.snapshot(sessionId)?.[MODERN_MODEL_SELECTION_PROJECTION_KEY];
  if (!row || row.seq <= beforeSeq) return;
  const selected = parseProjectionSelection(row.value);
  if (selected && sameSelection(selected, requested)) {
    throw configurationError(
      "protocolError",
      "DeepSeek Harness rejected a Model selection that its projection committed",
    );
  }
}

function assertNoPermissionMutationContradiction(
  control: ModernConfigurationControl,
  sessionId: string,
  beforeSeq: number,
  catalog: HarnessPermissionModeCatalog,
  requested: HarnessPermissionModeId,
): void {
  const row = control.snapshot(sessionId)?.[MODERN_PERMISSION_PROJECTION_KEY];
  if (!row || row.seq <= beforeSeq) return;
  if (isModernPermissionModeProjectionMatch(row.value, catalog, requested)) {
    throw configurationError(
      "protocolError",
      "DeepSeek Harness rejected a Permission Mode that its projection committed",
    );
  }
}

function normalizeConnectionFailure(error: unknown, operation: string): ModernConfigurationError {
  if (error instanceof ModernConfigurationError) return error;
  if (error instanceof ModernCommandError) {
    return configurationError(error.code, error.message, error.nativeCode);
  }
  if (error instanceof ModernRemoteConnectionError) {
    return configurationError(error.code, `${operation}: ${error.message}`, error.nativeCode);
  }
  return configurationError("unavailable", operation);
}

function isUncertainTransportFailure(error: unknown): boolean {
  const code =
    error instanceof ModernRemoteConnectionError || error instanceof ModernCommandError
      ? error.code
      : undefined;
  return code === "processExited" || code === "unavailable";
}

function isProjectionProtocolFailure(error: unknown): error is ModernControlStoreError {
  return (
    error instanceof ModernControlStoreError &&
    (error.code === "protocolError" || error.code === "resourceLimit")
  );
}

async function waitForModelSelection(
  control: ModernConfigurationControl,
  sessionId: string,
  afterSeq: number,
  expected: DeepSeekModelSelection,
  signal?: AbortSignal,
): Promise<ModernProjectionRow> {
  let malformed: ModernConfigurationError | undefined;
  const row = await control.waitFor(
    sessionId,
    MODERN_MODEL_SELECTION_PROJECTION_KEY,
    afterSeq,
    (value) => {
      try {
        const selected = parseProjectionSelection(value);
        return selected !== null && sameSelection(selected, expected);
      } catch (error) {
        malformed =
          error instanceof ModernConfigurationError
            ? error
            : configurationError(
                "protocolError",
                "DeepSeek Harness returned an invalid modelSelection projection",
              );
        return true;
      }
    },
    signal ? { signal } : {},
  );
  if (malformed) throw malformed;
  return row;
}

async function requireModernModelSelectionState(
  control: ModernConfigurationControl,
  sessionId: string,
  catalog: ModernModelCatalogSnapshot,
  signal?: AbortSignal,
  allowMissing = false,
): Promise<ModernModelSelectionState> {
  const rows = control.snapshot(sessionId);
  const existing = rows?.[MODERN_MODEL_SELECTION_PROJECTION_KEY];
  if (existing) return readModernModelSelectionState(existing, catalog);
  if (allowMissing && rows) {
    return {
      selection: catalog.defaultSelection,
      projectionSeq: -1,
      explicit: false,
    };
  }
  let malformed: ModernConfigurationError | undefined;
  const row = await control.waitFor(
    sessionId,
    MODERN_MODEL_SELECTION_PROJECTION_KEY,
    -1,
    (value) => {
      try {
        parseProjectionSelection(value);
      } catch (error) {
        malformed =
          error instanceof ModernConfigurationError
            ? error
            : configurationError(
                "protocolError",
                "DeepSeek Harness returned an invalid modelSelection projection",
              );
      }
      return true;
    },
    signal ? { signal } : {},
  );
  if (malformed) throw malformed;
  return readModernModelSelectionState(row, catalog);
}

async function requireModernPermissionModeState(
  control: ModernConfigurationControl,
  sessionId: string,
  catalog: HarnessPermissionModeCatalog,
  signal: AbortSignal,
): Promise<NonNullable<ReturnType<typeof readModernPermissionModeState>>> {
  const existing = control.snapshot(sessionId)?.[MODERN_PERMISSION_PROJECTION_KEY];
  if (existing)
    return readModernPermissionModeState(existing, catalog) as NonNullable<
      ReturnType<typeof readModernPermissionModeState>
    >;
  let malformed: ModernConfigurationError | undefined;
  const row = await control.waitFor(
    sessionId,
    MODERN_PERMISSION_PROJECTION_KEY,
    -1,
    (value) => {
      try {
        readModernPermissionModeState({ value, seq: 0 }, catalog);
      } catch (error) {
        malformed = configurationError(
          "protocolError",
          error instanceof ModernPermissionModeError
            ? error.message
            : "DeepSeek Harness returned an invalid permissions projection",
        );
      }
      return true;
    },
    { signal },
  );
  if (malformed) throw malformed;
  return readModernPermissionModeState(row, catalog) as NonNullable<
    ReturnType<typeof readModernPermissionModeState>
  >;
}

async function waitForPermissionMode(
  control: ModernConfigurationControl,
  sessionId: string,
  afterSeq: number,
  catalog: HarnessPermissionModeCatalog,
  expected: HarnessPermissionModeId,
  signal: AbortSignal,
): Promise<ModernProjectionRow> {
  let malformed: ModernConfigurationError | undefined;
  const row = await control.waitFor(
    sessionId,
    MODERN_PERMISSION_PROJECTION_KEY,
    afterSeq,
    (value) => {
      try {
        return isModernPermissionModeProjectionMatch(value, catalog, expected);
      } catch (error) {
        malformed = configurationError(
          "protocolError",
          error instanceof ModernPermissionModeError
            ? error.message
            : "DeepSeek Harness returned an invalid permissions projection",
        );
        return true;
      }
    },
    { signal },
  );
  if (malformed) throw malformed;
  return row;
}

export function modernConfigurationHarnessError(error: unknown): HarnessError {
  if (!(error instanceof ModernConfigurationError)) {
    return {
      code: "nativeFailure",
      message: "DeepSeek Harness configuration failed",
      retryable: false,
    };
  }
  const code =
    error.code === "authenticationRequired" ||
    error.code === "invalidRequest" ||
    error.code === "notInstalled" ||
    error.code === "processExited" ||
    error.code === "protocolError" ||
    error.code === "unsupported" ||
    error.code === "unavailable"
      ? error.code
      : error.code === "limitExceeded"
        ? "protocolError"
        : error.code === "cancelled"
          ? "unavailable"
          : error.nativeCode === "session/not-found"
            ? "sessionNotFound"
            : error.nativeCode === "session/agent-busy"
              ? "sessionBusy"
              : "nativeFailure";
  return {
    code,
    message: error.message,
    retryable: code === "unavailable" || code === "processExited" || code === "sessionBusy",
    ...(error.nativeCode ? { diagnostic: error.nativeCode } : {}),
  };
}
