/**
 * Configuration commands for OmO Sessions: Model, Thinking, and Permission
 * Mode selection, and the Permission Mode application that implements the
 * `unattended-full-access` execution policy at Session creation.
 *
 * Confirmation rule shared by every write: requested is not effective. A
 * command only completes after the engine answered it successfully AND a
 * fresh `get_state` agrees with what was asked for; until then no state is
 * published. A native refusal returns a typed error and leaves the Session
 * state untouched.
 *
 * - `model.select` sends `set_model {provider, modelId, scope: "session",
 *   effectId}`. The scope is mandatory (without it the switch also rewrites
 *   the device's default model) and is only sent when the engine advertises
 *   `session_model_scope`; an engine without that capability cannot switch
 *   one session only, so the selection is refused instead. The effect receipt
 *   answers `done` only once the engine emitted `model_changed`, which makes
 *   the receipt itself the native attestation of the broadcast. A switch the
 *   engine holds for compaction is confirmed through `get_state`'s
 *   `pendingModelSwitch`.
 * - `thinking.select` sends `set_thinking_level {level, scope: "turn",
 *   effectId}`. `scope: "turn"` changes this session's level without
 *   rewriting the model's remembered level. A level the active model cannot
 *   apply is refused by the engine and leaves the level unchanged.
 * - `permissionMode.select` sends `set_permission_preset {permissionPreset}`
 *   (not an effect-ledger command, so no effectId). The native confirmation
 *   is the response's `permissionPresetStatus: "applied"` plus `get_state`'s
 *   effective preset. `permissionModeScope` is `live`: presets apply from the
 *   next permission decision, including mid-Turn.
 *
 * The Permission Mode catalog is frozen from observations of the real engine,
 * never from documentation alone: `.omo/evidence/task-10-add-omo-harness.md`
 * records the probe that drove `set_permission_preset` for every candidate
 * value against omo 5.1.83 (classic connection, isolated agent dir) and the
 * set below is exactly what the engine accepted.
 */

import { randomUUID } from "node:crypto";

import { compositeModelRefIds } from "@codexhost/harness-adapter";
import type {
  HarnessError,
  HarnessModelRef,
  HarnessResult,
  HarnessSessionState,
} from "@codexhost/harness-adapter";
import {
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessResolvedModelLabelSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

import {
  OMO_THINKING_LEVELS,
  OMO_THINKING_OPTION_IDS,
  OMO_THINKING_OPTIONS,
  type OmoThinkingLevel,
} from "./omo-model-catalog.js";
import { assertCompatible, parseOmoProtocolInfo } from "./omo-protocol.js";
import {
  OmoRpcResponseError,
  type OmoNativeModelRef,
  type OmoRpcSessionState,
} from "./omo-rpc-session.js";

/**
 * Preset values the real 5.1.83 engine accepted through `set_permission_preset`
 * on a classic connection (probe of 2026-11-26; every candidate was offered and
 * each answer is recorded verbatim in the task-10 evidence). `accept-edits` and
 * `auto` are accepted even though the multi-session normative table gates them
 * behind host capabilities this classic connection does not advertise — the
 * observed engine behaviour wins.
 */
export const OMO_PROBED_PERMISSION_PRESETS: readonly string[] = Object.freeze([
  "full-access",
  "workspace",
  "read-only",
  "ask",
  "accept-edits",
  "auto",
]);

/**
 * The engine's own default preset (`permissionPresetSource: "host_default"` in
 * the probe's first `get_state`), used as the catalog's default mode.
 */
const OMO_PROBED_PERMISSION_DEFAULT = "full-access";

/** Native preset the `unattended-full-access` execution policy maps to. */
export const OMO_FULL_ACCESS_PRESET = "full-access";

/** Presentation of every preset the probe may accept; ids map one to one. */
const OMO_PERMISSION_PRESET_PRESENTATIONS: Readonly<
  Record<string, { label: string; description: string; dangerous?: true }>
> = Object.freeze({
  "full-access": {
    label: "Full access",
    description: "Run every tool action without approval prompts.",
    dangerous: true,
  },
  workspace: {
    label: "Workspace",
    description:
      "Automatically allow operations scoped to the workspace; ask for anything outside it.",
  },
  "read-only": {
    label: "Read only",
    description: "Automatically allow reads; ask before any write or execution.",
  },
  ask: {
    label: "Ask",
    description: "Ask before every gated tool action.",
  },
  "accept-edits": {
    label: "Accept edits",
    description:
      "Automatically allow project reads and edits; ask for shell commands and the rest.",
  },
  auto: {
    label: "Auto",
    description:
      "Let the engine's settings and remembered approvals decide; rules only narrow this mode.",
  },
});

/**
 * Builds the Permission Mode catalog from probe observations. Only presets the
 * real engine accepted may enter the catalog, and the observed default must be
 * one of them; anything else is a wiring error that fails at load time.
 */
export function omoPermissionModeCatalogFromProbe(
  accepted: readonly string[],
  defaultPreset: string,
): HarnessPermissionModeCatalog {
  if (accepted.length === 0) {
    throw new Error("OmO Permission Mode probe accepted no preset");
  }
  const seen = new Set<string>();
  for (const preset of accepted) {
    if (typeof preset !== "string" || preset.trim().length === 0 || seen.has(preset)) {
      throw new Error(`OmO Permission Mode probe contains an invalid preset '${preset}'`);
    }
    if (OMO_PERMISSION_PRESET_PRESENTATIONS[preset] === undefined) {
      throw new Error(`OmO Permission Mode preset '${preset}' has no presentation`);
    }
    seen.add(preset);
  }
  if (!seen.has(defaultPreset)) {
    throw new Error(`OmO Permission Mode default '${defaultPreset}' was not accepted by the probe`);
  }
  return harnessPermissionModeCatalogSchema.parse({
    modes: accepted.map((preset) => ({
      id: preset,
      ...OMO_PERMISSION_PRESET_PRESENTATIONS[preset],
    })),
    defaultModeId: defaultPreset,
  });
}

/** The frozen Permission Mode catalog; see the module doc for provenance. */
export const OMO_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  omoPermissionModeCatalogFromProbe(OMO_PROBED_PERMISSION_PRESETS, OMO_PROBED_PERMISSION_DEFAULT);

const OMO_PERMISSION_PRESET_IDS: ReadonlySet<string> = new Set(
  OMO_PERMISSION_MODE_CATALOG.modes.map((mode) => mode.id),
);

/** The native preset a Harness Permission Mode id names, or null when unknown. */
export function omoNativePermissionPreset(id: HarnessPermissionModeId): string | null {
  return OMO_PERMISSION_PRESET_IDS.has(id) ? id : null;
}

/** The effective Permission Mode id for a native preset, or null when unknown. */
export function omoEffectivePermissionModeId(
  preset: string | null,
): HarnessPermissionModeId | null {
  if (preset === null) return null;
  return OMO_PERMISSION_PRESET_IDS.has(preset) ? harnessPermissionModeIdSchema.parse(preset) : null;
}

/**
 * Command surface the configuration flows need. `OmoRpcSession` satisfies it;
 * unit tests answer it with a scripted channel.
 */
export interface OmoConfigurationChannel {
  send(
    command: string,
    payload?: Readonly<Record<string, unknown>>,
    options?: { timeoutMs?: number },
  ): Promise<{ data?: unknown }>;
  refreshState(options?: { timeoutMs?: number }): Promise<OmoRpcSessionState>;
}

/** The configuration fields of a Harness Session State (identity excluded). */
export type OmoConfigurationState = Omit<HarnessSessionState, "nativeRef">;

/** A Model row as the configuration flows read it from `get_available_models`. */
interface OmoCatalogModelRow {
  provider: string;
  id: string;
  name: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function invalidRequest(message: string): HarnessError {
  return { code: "invalidRequest", message, retryable: false };
}

function unsupported(message: string): HarnessError {
  return { code: "unsupported", message, retryable: false };
}

function nativeFailure(message: string): HarnessError {
  return { code: "nativeFailure", message, retryable: false };
}

function authenticationRequired(message: string): HarnessError {
  return { code: "authenticationRequired", message, retryable: false };
}

function protocolError(message: string): HarnessError {
  return { code: "protocolError", message, retryable: false };
}

function busy(message: string): HarnessError {
  return { code: "sessionBusy", message, retryable: true };
}

/** Maps a native refusal of a configuration command to the public error. */
function configResponseError(error: OmoRpcResponseError, subject: string): HarnessError {
  switch (error.errorCode) {
    case "model_not_found":
      return invalidRequest(`OmO does not offer ${subject}: ${error.message}`);
    case "context_budget":
      return nativeFailure(`OmO refused ${subject} on the context budget: ${error.message}`);
    case "provider_unavailable":
      return authenticationRequired(`OmO has no credentials for ${subject}: ${error.message}`);
    case "invalid_launch_profile":
      // The engine refused a preset our frozen catalog offers: the catalog is
      // stale for this engine version, which is a native failure to report,
      // not a caller error.
      return nativeFailure(
        `OmO refused ${subject}; the Permission Mode catalog may be stale for this engine: ${error.message}`,
      );
    default:
      break;
  }
  if (error.category === "busy") return busy(error.message);
  if (error.category === "authentication") return authenticationRequired(error.message);
  if (error.category === "configuration") {
    return { code: "configurationRequired", message: error.message, retryable: false };
  }
  return nativeFailure(error.message);
}

/** The effect receipt state of a successful configuration command, if present. */
function receiptState(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const state = data.state ?? (isRecord(data.effect) ? data.effect.state : undefined);
  return typeof state === "string" ? state : null;
}

/** Reads `get_state.pendingModelSwitch` (always present on 5.1.83, null when free). */
function pendingModelSwitch(state: OmoRpcSessionState): OmoNativeModelRef | null {
  const pending = state.raw.pendingModelSwitch;
  if (!isRecord(pending)) return null;
  const provider = nonEmptyString(pending.provider);
  const id = nonEmptyString(pending.id);
  return provider && id ? { provider, id } : null;
}

function sameModel(model: OmoNativeModelRef | null, requested: OmoNativeModelRef): boolean {
  return model !== null && model.provider === requested.provider && model.id === requested.id;
}

/**
 * Model Ref ids mirror omo-model-catalog.ts (readable `provider/model`, the
 * catalog's opaque encoding as the collision fallback) so a selected Ref
 * resolves in the published catalog. Keep the encoding in sync with that
 * module and omo-history.ts.
 */
const OMO_MODEL_REF_PREFIX = "omo-model-v1.";

function encodedRefId(entry: { provider: string; model: string }): string {
  return `${OMO_MODEL_REF_PREFIX}${Buffer.from(JSON.stringify([entry.provider, entry.model])).toString("base64url")}`;
}

/**
 * Readable single-pair Ref for a model the catalog rows did not cover; the
 * encoding matches `compositeModelRefIds`, which maps a unique pair to
 * `provider/model`.
 */
function readableOmoModelRef(model: OmoNativeModelRef): HarnessModelRef {
  return harnessModelRefSchema.parse({ id: `${model.provider}/${model.id}` });
}

/** Ref resolution and catalog rows for one `get_available_models` answer. */
interface OmoModelIndex {
  /** Exact ref lookup for model.select. */
  resolve(
    ref: HarnessModelRef,
  ): { provider: string; modelId: string; row: OmoCatalogModelRow } | null;
  /** Ref and row for a native pair (state building). */
  entry(model: OmoNativeModelRef): { ref: HarnessModelRef; row: OmoCatalogModelRow } | null;
}

function omoModelIndex(rows: readonly OmoCatalogModelRow[]): OmoModelIndex {
  const unique = new Map<string, OmoCatalogModelRow>(
    rows.map((row) => [JSON.stringify([row.provider, row.id]), row] as const),
  );
  const ids = compositeModelRefIds(
    [...unique.values()].map((row) => ({ provider: row.provider, model: row.id })),
    encodedRefId,
  );
  const refIdByPair = new Map<string, string>(
    [...ids.entries()].map(
      ([refId, value]) => [JSON.stringify([value.provider, value.model]), refId] as const,
    ),
  );
  const byPair = new Map<string, { ref: HarnessModelRef; row: OmoCatalogModelRow }>();
  for (const [pair, row] of unique) {
    const refId = refIdByPair.get(pair);
    if (refId === undefined) continue;
    const parsed = harnessModelRefSchema.safeParse({ id: refId });
    if (parsed.success) byPair.set(pair, { ref: parsed.data, row });
  }
  const modelByRefId = new Map<string, OmoNativeModelRef>(
    [...ids.entries()].map(([refId, value]) => [
      refId,
      { provider: value.provider, id: value.model },
    ]),
  );
  return {
    resolve: (ref) => {
      const model = modelByRefId.get(ref.id);
      if (!model) return null;
      const found = byPair.get(JSON.stringify([model.provider, model.id]));
      return found ? { provider: model.provider, modelId: model.id, row: found.row } : null;
    },
    entry: (model) => byPair.get(JSON.stringify([model.provider, model.id])) ?? null,
  };
}

/** A configuration answer or engine state violates the documented shape. */
export class OmoConfigurationProtocolError extends Error {
  readonly code = "protocolError" as const;

  constructor(message: string) {
    super(message);
    this.name = "OmoConfigurationProtocolError";
  }
}

/** Parses the model rows a `get_available_models` answer carries. */
export function omoCatalogModelRows(data: unknown): OmoCatalogModelRow[] {
  if (!isRecord(data) || !Array.isArray(data.models)) {
    throw new OmoConfigurationProtocolError(
      "OmO get_available_models response has no models array",
    );
  }
  const rows: OmoCatalogModelRow[] = [];
  for (const value of data.models) {
    if (!isRecord(value)) continue;
    const provider = nonEmptyString(value.provider);
    const id = nonEmptyString(value.id);
    if (!provider || !id) continue;
    rows.push({ provider, id, name: nonEmptyString(value.name) });
  }
  return rows;
}

/**
 * The confirmed configuration fields of a native state, plus optional reads
 * the flows collected on the way (catalog rows for labels, the current
 * model's thinking levels). Everything published comes from native answers.
 */
export function omoConfirmedConfigurationState(
  state: OmoRpcSessionState,
  extras: {
    models?: readonly OmoCatalogModelRow[];
    thinkingLevels?: readonly string[] | undefined;
  } = {},
): OmoConfigurationState {
  const index = omoModelIndex(extras.models ?? []);
  const entry = state.model === null ? null : index.entry(state.model);
  const resolvedModelLabel =
    entry?.row.name ?? (isRecord(state.raw.model) ? nonEmptyString(state.raw.model.name) : null);
  const parsedLabel =
    resolvedModelLabel === null
      ? undefined
      : harnessResolvedModelLabelSchema.safeParse(resolvedModelLabel);
  const thinkingLevel = state.thinkingLevel;
  const effectiveThinkingOptionId =
    thinkingLevel !== null && (OMO_THINKING_LEVELS as readonly string[]).includes(thinkingLevel)
      ? OMO_THINKING_OPTION_IDS[thinkingLevel as OmoThinkingLevel]
      : undefined;
  const availableThinkingOptions =
    extras.thinkingLevels === undefined
      ? undefined
      : OMO_THINKING_OPTIONS.filter((option) => extras.thinkingLevels?.includes(option.id));
  const effectivePermissionModeId = omoEffectivePermissionModeId(
    state.effectivePermissionPreset ?? state.permissionPreset,
  );
  return {
    ...(entry === null
      ? state.model === null
        ? {}
        : { effectiveModel: readableOmoModelRef(state.model) }
      : { effectiveModel: entry.ref }),
    ...(parsedLabel?.success ? { resolvedModelLabel: parsedLabel.data } : {}),
    ...(effectiveThinkingOptionId === undefined ? {} : { effectiveThinkingOptionId }),
    ...(availableThinkingOptions === undefined ? {} : { availableThinkingOptions }),
    ...(effectivePermissionModeId === null ? {} : { effectivePermissionModeId }),
  };
}

/** Reads `get_available_thinking_levels` (levels of the current model). */
async function readThinkingLevels(
  channel: OmoConfigurationChannel,
  options: { timeoutMs?: number },
): Promise<readonly string[] | undefined> {
  try {
    const response = await channel.send("get_available_thinking_levels", {}, options);
    if (!isRecord(response.data) || !Array.isArray(response.data.levels)) return undefined;
    return response.data.levels.filter((level): level is string => typeof level === "string");
  } catch {
    // The levels are advisory state; a failed read omits them, it never fails
    // a confirmed selection.
    return undefined;
  }
}

/** Negotiates capabilities for one selection; a malformed answer is typed. */
async function negotiateOmoCapabilities(
  channel: OmoConfigurationChannel,
  options: { timeoutMs?: number },
): Promise<HarnessResult<{ sessionModelScope: boolean; effectLedger: boolean }>> {
  let protocol;
  try {
    const response = await channel.send("get_protocol_info", {}, options);
    protocol = parseOmoProtocolInfo(response.data);
    assertCompatible(protocol);
  } catch (error) {
    return {
      ok: false,
      error: protocolError(
        `OmO capability negotiation for the selection failed: ${messageOf(error)}`,
      ),
    };
  }
  return {
    ok: true,
    value: {
      sessionModelScope: protocol.hasCapability("session_model_scope"),
      effectLedger: protocol.hasCapability("effect_ledger"),
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------- model select

/**
 * `model.select`: resolve the requested Ref against the live catalog, switch
 * with session scope, and publish state only after the engine confirmed.
 * Works while a Turn streams; a concurrent configuration command is refused
 * by the Session, not here.
 */
export async function selectOmoModel(
  channel: OmoConfigurationChannel,
  requested: HarnessModelRef,
  options: { timeoutMs?: number } = {},
): Promise<HarnessResult<OmoConfigurationState>> {
  const negotiated = await negotiateOmoCapabilities(channel, options);
  if (!negotiated.ok) return negotiated;
  if (!negotiated.value.sessionModelScope) {
    return {
      ok: false,
      error: unsupported(
        "OmO Model selection needs an engine that can switch one session without moving the device default",
      ),
    };
  }
  let rows: OmoCatalogModelRow[];
  try {
    rows = omoCatalogModelRows((await channel.send("get_available_models", {}, options)).data);
  } catch (error) {
    return { ok: false, error: protocolError(messageOf(error)) };
  }
  const index = omoModelIndex(rows);
  const target = index.resolve(harnessModelRefSchema.parse(requested));
  if (!target) {
    return { ok: false, error: invalidRequest(`OmO does not offer Model '${requested.id}'`) };
  }
  const effectId = negotiated.value.effectLedger ? `codexhost-omo-${randomUUID()}` : undefined;
  let response;
  try {
    response = await channel.send(
      "set_model",
      {
        provider: target.provider,
        modelId: target.modelId,
        scope: "session",
        ...(effectId === undefined ? {} : { effectId }),
      },
      options,
    );
  } catch (error) {
    if (error instanceof OmoRpcResponseError) {
      return { ok: false, error: configResponseError(error, `Model '${requested.id}'`) };
    }
    throw error;
  }
  if (receiptState(response.data) === "failed") {
    return { ok: false, error: nativeFailure("OmO recorded a failed Model switch receipt") };
  }
  const state = await channel.refreshState(options);
  const confirmed =
    sameModel(state.model, { provider: target.provider, id: target.modelId }) ||
    sameModel(pendingModelSwitch(state), { provider: target.provider, id: target.modelId });
  if (!confirmed) {
    return {
      ok: false,
      error: nativeFailure(
        `OmO did not activate the requested Model '${requested.id}'; the confirmed state is unchanged`,
      ),
    };
  }
  return {
    ok: true,
    value: omoConfirmedConfigurationState(state, {
      models: rows,
      thinkingLevels: await readThinkingLevels(channel, options),
    }),
  };
}

// ------------------------------------------------------------- thinking select

/** The native level a Harness Thinking option id names, or null when unknown. */
export function omoThinkingLevelOf(thinkingOptionId: string): OmoThinkingLevel | null {
  return (OMO_THINKING_LEVELS as readonly string[]).includes(thinkingOptionId)
    ? (thinkingOptionId as OmoThinkingLevel)
    : null;
}

/**
 * `thinking.select`: set this session's level (`scope: "turn"`, which does not
 * rewrite the model's remembered level) and publish state after the engine
 * confirmed it. A level the active model cannot apply is refused natively.
 */
export async function selectOmoThinking(
  channel: OmoConfigurationChannel,
  thinkingOptionId: string,
  options: { timeoutMs?: number } = {},
): Promise<HarnessResult<OmoConfigurationState>> {
  const level = omoThinkingLevelOf(thinkingOptionId);
  if (level === null) {
    return {
      ok: false,
      error: invalidRequest(`OmO Thinking option '${thinkingOptionId}' is unknown`),
    };
  }
  const negotiated = await negotiateOmoCapabilities(channel, options);
  if (!negotiated.ok) return negotiated;
  const effectId = negotiated.value.effectLedger ? `codexhost-omo-${randomUUID()}` : undefined;
  let response;
  try {
    response = await channel.send(
      "set_thinking_level",
      {
        level,
        scope: "turn",
        ...(effectId === undefined ? {} : { effectId }),
      },
      options,
    );
  } catch (error) {
    if (error instanceof OmoRpcResponseError) {
      return {
        ok: false,
        error: configResponseError(error, `Thinking level '${level}'`),
      };
    }
    throw error;
  }
  if (receiptState(response.data) === "failed") {
    return { ok: false, error: nativeFailure("OmO recorded a failed Thinking switch receipt") };
  }
  const state = await channel.refreshState(options);
  if (state.thinkingLevel !== level) {
    return {
      ok: false,
      error: nativeFailure(
        `OmO did not apply Thinking level '${level}'; the confirmed state is unchanged`,
      ),
    };
  }
  let rows: OmoCatalogModelRow[];
  try {
    rows = omoCatalogModelRows((await channel.send("get_available_models", {}, options)).data);
  } catch {
    rows = [];
  }
  return {
    ok: true,
    value: omoConfirmedConfigurationState(state, {
      models: rows,
      thinkingLevels: await readThinkingLevels(channel, options),
    }),
  };
}

// ---------------------------------------------------------- permission select

/**
 * Applies a Permission Mode natively and publishes state only after the
 * engine confirmed it: the response must carry `permissionPresetStatus:
 * "applied"` and a fresh `get_state` must agree. Shared by
 * `permissionMode.select` and the `unattended-full-access` open policy.
 */
export async function applyOmoPermissionMode(
  channel: OmoConfigurationChannel,
  preset: string,
  options: { timeoutMs?: number } = {},
): Promise<HarnessResult<OmoConfigurationState>> {
  let response;
  try {
    response = await channel.send("set_permission_preset", { permissionPreset: preset }, options);
  } catch (error) {
    if (error instanceof OmoRpcResponseError) {
      return { ok: false, error: configResponseError(error, `Permission Mode '${preset}'`) };
    }
    throw error;
  }
  const data = isRecord(response.data) ? response.data : {};
  const status = data.permissionPresetStatus;
  if (status !== "applied") {
    return {
      ok: false,
      error: nativeFailure(
        `OmO did not confirm Permission Mode '${preset}' (status '${status ?? "missing"}')`,
      ),
    };
  }
  const state = await channel.refreshState(options);
  const effective = state.effectivePermissionPreset ?? state.permissionPreset;
  if (effective !== preset) {
    return {
      ok: false,
      error: nativeFailure(
        `OmO did not activate Permission Mode '${preset}'; the confirmed state is unchanged`,
      ),
    };
  }
  let rows: OmoCatalogModelRow[];
  try {
    rows = omoCatalogModelRows((await channel.send("get_available_models", {}, options)).data);
  } catch {
    rows = [];
  }
  return {
    ok: true,
    value: omoConfirmedConfigurationState(state, {
      models: rows,
      thinkingLevels: await readThinkingLevels(channel, options),
    }),
  };
}

/**
 * `permissionMode.select`: validate the id against the frozen catalog, then
 * apply natively with confirmation. Unknown ids never reach the engine.
 */
export async function selectOmoPermissionMode(
  channel: OmoConfigurationChannel,
  permissionModeId: HarnessPermissionModeId,
  options: { timeoutMs?: number } = {},
): Promise<HarnessResult<OmoConfigurationState>> {
  const preset = omoNativePermissionPreset(permissionModeId);
  if (preset === null) {
    return {
      ok: false,
      error: invalidRequest(`OmO does not offer Permission Mode '${permissionModeId}'`),
    };
  }
  return applyOmoPermissionMode(channel, preset, options);
}
