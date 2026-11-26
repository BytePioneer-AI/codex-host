/**
 * History reading and snapshot projection for OmO Sessions.
 *
 * OmO persists a Session as an append-only tree of entries. Every entry has a
 * stable id, a `parentId`, and for `message` entries a message payload with
 * role/content/stopReason/timestamp. The *effective branch* is the path from
 * the tree's current leaf to its root; entries on abandoned branches stay in
 * the file but are not part of the conversation. `get_tree` reports the
 * current leafId; `get_entries` returns every entry in append order, paged.
 *
 * Intended use (omo-session.ts):
 *
 * ```ts
 * const channel: OmoHistoryChannel = rpc;   // an OmoRpcSession satisfies it
 * const history = await readOmoHistory(channel);
 * const snapshot = mapOmoSnapshot(history, {
 *   sessionId: rpc.state.sessionId ?? nativeRef.nativeSessionId,
 *   model: rpc.state.model,
 *   models: catalog.models,                 // optional, enables Turn model refs
 * });
 * // or both steps in one call:
 * const snapshot = await readOmoSnapshot(channel, state);
 * ```
 *
 * Identity rules, stable across reads and restarts:
 *
 * - Turn identity: `nativeTurnKey = turn:<user-message entry id>`
 *   ({@link omoHistoryTurnKey}). The engine's admission turn id
 *   (`get_state.currentTurnId`, prompt `data.turnId`) is NOT persisted on
 *   history entries, so the live Session must build its `turn.completed`
 *   nativeTurnRef with the same helper; the user-message entry id is the only
 *   durable turn identity.
 * - Item identity: `omo-item-v1-<entry id>-<kind>-<ordinal>` — entry ids
 *   verbatim, no hashing.
 * - Checkpoint: the Turn's user-message entry id (`fork(entryId)` excludes the
 *   boundary entry itself, so a fork boundary is the next Turn's user id).
 *
 * Read consistency: `get_tree` is read first, the entry pages after. Entries
 * collected later include every ancestor of the earlier tree leaf, so a
 * concurrent append cannot orphan the walk. Reading in the other order could
 * see a leaf no collected page contains.
 *
 * Paging: every `get_entries` request carries `limit` <= 500 entries and
 * `maxBytes` <= 8 MiB, keeping one answer far under the connection's 64 MiB
 * single-line limit. A `response_too_large` refusal shrinks `limit` towards
 * 1, then raises `maxBytes` to the protocol's 48 MiB answer cap for a single
 * large Entry; a refusal past both bounds becomes a typed protocol error (no
 * answer can carry that Entry), so the walk always terminates. Memory: the
 * reader holds every Entry of the Session at once, abandoned branches
 * included — bounded by the serialized Session size on disk.
 *
 * Known projection limits (documented, not silent):
 *
 * - No `fileChange` Items from history: deriving them needs tool-specific
 *   argument knowledge owned by the live session surface.
 * - `exitCode`/`durationMs` are not projected from persisted toolResults: the
 *   session format documents neither on the entry. Live Items carry them when
 *   the engine reports them.
 * - Turn input is text only; image content parts are not projected.
 * - Turns start at user-message entries. A run an extension triggered with a
 *   custom message produces no Turn here; its compaction and model effects
 *   still apply to the surrounding Turns.
 */

import { compositeModelRefIds } from "@codexhost/harness-adapter";
import type {
  HostAgentMessageItem,
  HostCommandExecutionItem,
  HostContextCompactionItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostMcpToolCallItem,
  HostReasoningItem,
  HostThreadSnapshot,
  HostToolExecutionItem,
  HostToolOutput,
  HistoricalTurnOutcome,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  hostItemIdSchema,
  jsonValueSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HarnessModelRef,
  type JsonObject,
  type JsonValue,
  type NativeCheckpointRef,
} from "@codexhost/shared-contracts";

import type { OmoResponseFrame } from "./omo-protocol.js";
import { OmoRpcResponseError, type OmoNativeModelRef } from "./omo-rpc-session.js";

/** Entries per `get_entries` page. */
const OMO_ENTRIES_PAGE_LIMIT = 500;
/** Serialized-bytes bound per `get_entries` page (8 MiB). */
const OMO_ENTRIES_PAGE_BYTES = 8 * 1024 * 1024;
/** The protocol's absolute answer cap; a larger single Entry cannot travel. */
const OMO_ENTRIES_MAX_PAGE_BYTES = 48 * 1024 * 1024;

const omoHarnessId: HarnessId = harnessIdSchema.parse("omo");

/** A history answer or entry graph violates the documented OmO format. */
export class OmoHistoryProtocolError extends Error {
  readonly code = "protocolError" as const;

  constructor(message: string) {
    super(message);
    this.name = "OmoHistoryProtocolError";
  }
}

/**
 * Command surface the history reader needs. `OmoRpcSession` satisfies it:
 * `send` resolves only for a successful response and rejects with an
 * `OmoRpcResponseError` carrying the native `errorCode` when the engine
 * refuses the command.
 */
export interface OmoHistoryChannel {
  send(
    command: string,
    payload?: Readonly<Record<string, unknown>>,
    options?: { timeoutMs?: number },
  ): Promise<OmoResponseFrame>;
}

/** Every Session entry in append order (all branches) plus the tree's leaf. */
export interface OmoSessionHistory {
  entries: JsonObject[];
  /** The effective branch's newest entry; null for a Session with no entries. */
  leafId: string | null;
}

/** Session identity and Model context for one snapshot projection. */
export interface OmoHistoryState {
  /**
   * The persisted native Session id; it must match the nativeRef the Host
   * stored, because Turn and Checkpoint identity derive from it. A Session
   * without one has no projectable history identity.
   */
  sessionId: string;
  /** Effective Model when the history was read (get_state). */
  model?: OmoNativeModelRef | null;
  /** Known catalog Models, enabling per-Turn Model refs. */
  models?: readonly OmoNativeModelRef[];
}

interface OmoEntry extends JsonObject {
  id: string;
  parentId: string | null;
  type: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("");
}

function thinkingContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === "thinking" && typeof part.thinking === "string",
    )
    .map((part) => part.thinking as string)
    .join("");
}

function validatedEntry(value: JsonObject): OmoEntry {
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    (value.parentId !== null && typeof value.parentId !== "string") ||
    typeof value.type !== "string"
  ) {
    throw new OmoHistoryProtocolError("OmO history contains an invalid Entry identity");
  }
  return value as OmoEntry;
}

/**
 * The root-to-leaf effective branch in conversation order. Abandoned branches
 * are excluded. A duplicate entry id, a cycle, or a missing parent anywhere
 * on the effective branch is a typed protocol error, never a partial answer.
 */
export function activeOmoEntries(history: OmoSessionHistory): OmoEntry[] {
  if (history.leafId === null) return [];
  const byId = new Map<string, OmoEntry>();
  for (const value of history.entries) {
    const entry = validatedEntry(value);
    if (byId.has(entry.id)) {
      throw new OmoHistoryProtocolError(`OmO history repeats entry id '${entry.id}'`);
    }
    byId.set(entry.id, entry);
  }
  const reversed: OmoEntry[] = [];
  const visited = new Set<string>();
  let current: string | null = history.leafId;
  while (current !== null) {
    if (visited.has(current)) {
      throw new OmoHistoryProtocolError("OmO history effective branch contains a cycle");
    }
    visited.add(current);
    const entry = byId.get(current);
    if (!entry) {
      throw new OmoHistoryProtocolError("OmO history effective branch references a missing Entry");
    }
    reversed.push(entry);
    current = entry.parentId;
  }
  return reversed.reverse();
}

/**
 * Stable identity of one OmO Turn: the user-message entry that started it,
 * prefixed to mark the key's meaning. The engine's live admission turn id is
 * not persisted on history entries, so the live Session builds its
 * nativeTurnRef with this helper too — both sides then agree across reads.
 */
export function omoHistoryTurnKey(userEntryId: string): string {
  return `turn:${userEntryId}`;
}

function message(entry: OmoEntry): Record<string, unknown> | null {
  return entry.type === "message" && isRecord(entry.message) ? entry.message : null;
}

function messageRole(entry: OmoEntry): string | null {
  const value = message(entry)?.role;
  return typeof value === "string" ? value : null;
}

function itemId(entryId: string, kind: string, ordinal: number) {
  return hostItemIdSchema.parse(`omo-item-v1-${entryId}-${kind}-${ordinal}`);
}

/**
 * Turn outcome from the last Assistant message of the reply chain. A missing
 * stopReason is judged only by the answer text that entry did persist —
 * never by an invented success or failure.
 */
function assistantOutcome(entries: OmoEntry[]): HistoricalTurnOutcome {
  const assistants = entries
    .map((entry) => message(entry))
    .filter((value): value is Record<string, unknown> => value?.role === "assistant");
  const final = assistants.at(-1);
  if (!final) return { status: "unknown", reason: "OmO history has no Assistant terminal" };
  const stopReason = final.stopReason;
  if (stopReason === "aborted") {
    return { status: "cancelled", reason: "OmO Assistant was aborted" };
  }
  if (stopReason === "error") {
    const diagnostic = isRecord(final.providerDiagnostic) ? final.providerDiagnostic : null;
    const category = diagnostic?.category;
    return {
      status: "failed",
      error: {
        // A provider auth failure is an authentication problem for the Host;
        // every other documented diagnostic category stays a native failure.
        code:
          category === "auth" ? ("authenticationRequired" as const) : ("nativeFailure" as const),
        message:
          typeof final.errorMessage === "string" && final.errorMessage.length > 0
            ? final.errorMessage
            : "OmO Assistant failed",
        retryable: false,
      },
    };
  }
  // Persisted Assistant messages carry a terminal stopReason; "pending" is the
  // streaming-only value the format says never reaches a file, so it does not
  // count as terminal here. An unknown future reason still ends the turn.
  if (
    (typeof stopReason === "string" && stopReason !== "pending") ||
    textContent(final.content).length > 0
  ) {
    return { status: "succeeded" };
  }
  return { status: "unknown", reason: "OmO Assistant terminal is not classifiable" };
}

function itemOutcome(outcome: HistoricalTurnOutcome): HostItemOutcome {
  if (outcome.status === "failed") return { status: "failed", error: outcome.error };
  if (outcome.status === "cancelled") {
    return {
      status: "cancelled",
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
  }
  return { status: "succeeded" };
}

function toolOutput(value: unknown): HostToolOutput | undefined {
  const text = textContent(value);
  return text.length > 0 ? { content: [{ type: "text", text }] } : undefined;
}

// Real 5.1.83 routes shell commands through the `eval` tool (task-9 trace);
// history keeps the same routing so a Tool call projects identically live and
// in snapshots.
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "exec", "terminal", "run", "eval"]);
const SHELL_COMMAND_KEYS: readonly string[] = [
  "command",
  "cmd",
  "script",
  "code",
  "commandLine",
  "command_line",
];

function stringField(value: JsonValue, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const source of [value, value.input, value.arguments]) {
    if (isRecord(source) && typeof source[key] === "string" && source[key].length > 0)
      return source[key];
  }
  return undefined;
}

/** Use the same native shell argument aliases for persisted tool calls. */
function shellCommand(
  name: string,
  arguments_: JsonValue,
): { command: string; cwd?: string } | null {
  if (!SHELL_TOOL_NAMES.has(name.toLowerCase())) return null;
  const command = SHELL_COMMAND_KEYS.map((key) => stringField(arguments_, key)).find(
    (value) => value !== undefined,
  );
  if (!command) return null;
  const cwd = stringField(arguments_, "cwd");
  return { command, ...(cwd ? { cwd } : {}) };
}

/**
 * `mcp__<server>__<tool>` — the persisted name. Live events recase the tool
 * (`resolvedToolName`); history keeps the persisted spelling.
 */
function mcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");
  const server = rest.slice(0, separator);
  const tool = rest.slice(separator + 2);
  if (separator <= 0 || server.length === 0 || tool.length === 0) return null;
  return { server, tool };
}

interface ToolCallRecord {
  entryId: string;
  ordinal: number;
  name: string;
  arguments: JsonValue;
}

function toolItem(
  call: ToolCallRecord,
  nativeMessage: Record<string, unknown>,
): HostCommandExecutionItem | HostMcpToolCallItem | HostToolExecutionItem {
  const output = toolOutput(nativeMessage.content);
  const shell = shellCommand(call.name, call.arguments);
  if (shell) {
    return {
      type: "commandExecution",
      itemId: itemId(call.entryId, "tool", call.ordinal),
      command: shell.command,
      ...(shell.cwd ? { cwd: shell.cwd } : {}),
      ...(output ? { output: textContent(nativeMessage.content) } : {}),
    };
  }
  const mcp = mcpToolName(call.name);
  if (mcp) {
    return {
      type: "mcpToolCall",
      itemId: itemId(call.entryId, "tool", call.ordinal),
      server: mcp.server,
      tool: mcp.tool,
      arguments: call.arguments,
      ...(output ? { output } : {}),
    };
  }
  return {
    type: "toolExecution",
    itemId: itemId(call.entryId, "tool", call.ordinal),
    toolName: call.name,
    arguments: call.arguments,
    ...(output ? { output } : {}),
  };
}

function snapshotItems(entries: OmoEntry[], outcome: HistoricalTurnOutcome): HostItemSnapshot[] {
  const snapshots: HostItemSnapshot[] = [];
  const toolCalls = new Map<string, ToolCallRecord>();
  for (const entry of entries) {
    if (entry.type === "compaction") {
      const item: HostContextCompactionItem = {
        type: "contextCompaction",
        itemId: itemId(entry.id, "compaction", 0),
      };
      snapshots.push({ item, outcome: { status: "succeeded" } });
      continue;
    }
    const nativeMessage = message(entry);
    if (!nativeMessage) continue;
    const content = Array.isArray(nativeMessage.content) ? nativeMessage.content : [];
    if (nativeMessage.role === "assistant") {
      const text = textContent(content);
      const reasoning = thinkingContent(content);
      let projectedText = false;
      let projectedReasoning = false;
      for (const [ordinal, part] of content.entries()) {
        if (!isRecord(part)) continue;
        if (part.type === "thinking" && !projectedReasoning && reasoning.length > 0) {
          const item: HostReasoningItem = {
            type: "reasoning",
            itemId: itemId(entry.id, "reasoning", 0),
            text: reasoning,
          };
          snapshots.push({ item, outcome: itemOutcome(outcome) });
          projectedReasoning = true;
          continue;
        }
        if (part.type === "text" && !projectedText && text.length > 0) {
          const item: HostAgentMessageItem = {
            type: "agentMessage",
            itemId: itemId(entry.id, "assistant", 0),
            text,
          };
          snapshots.push({ item, outcome: itemOutcome(outcome) });
          projectedText = true;
          continue;
        }
        if (
          part.type !== "toolCall" ||
          typeof part.id !== "string" ||
          typeof part.name !== "string"
        ) {
          continue;
        }
        const parsedArguments = jsonValueSchema.safeParse(part.arguments);
        if (!parsedArguments.success) continue;
        toolCalls.set(part.id, {
          entryId: entry.id,
          ordinal,
          name: part.name,
          arguments: parsedArguments.data,
        });
      }
      continue;
    }
    if (
      nativeMessage.role !== "toolResult" ||
      typeof nativeMessage.toolCallId !== "string" ||
      typeof nativeMessage.toolName !== "string"
    ) {
      continue;
    }
    const call = toolCalls.get(nativeMessage.toolCallId);
    if (!call || call.name !== nativeMessage.toolName) continue;
    snapshots.push({
      item: toolItem(call, nativeMessage),
      outcome:
        nativeMessage.isError === false
          ? { status: "succeeded" }
          : {
              status: "failed",
              error: {
                code: "nativeFailure",
                message: `OmO Tool '${call.name}' failed`,
                retryable: false,
              },
            },
    });
  }
  return snapshots;
}

function modelChange(entry: OmoEntry): OmoNativeModelRef | null {
  return entry.type === "model_change" &&
    typeof entry.provider === "string" &&
    typeof entry.modelId === "string"
    ? { provider: entry.provider, id: entry.modelId }
    : null;
}

/**
 * Model Ref ids mirror omo-model-catalog.ts so a history Ref resolves in the
 * catalog: readable `provider/model`, with the catalog's opaque encoding as
 * the collision fallback. Keep the encoding in sync with that module.
 */
function omoHistoryModelIndex(models: readonly OmoNativeModelRef[]): {
  ref(model: OmoNativeModelRef): HarnessModelRef | null;
} {
  const unique = new Map(
    models.map((model) => [JSON.stringify([model.provider, model.id]), model] as const),
  );
  const byId = compositeModelRefIds(
    [...unique.values()].map((model) => ({ provider: model.provider, model: model.id })),
    (entry) =>
      `omo-model-v1.${Buffer.from(JSON.stringify([entry.provider, entry.model])).toString("base64url")}`,
  );
  const idsByPair = new Map(
    [...byId].map(([id, entry]) => [JSON.stringify([entry.provider, entry.model]), id] as const),
  );
  return {
    ref: (model: OmoNativeModelRef) => {
      const id = idsByPair.get(JSON.stringify([model.provider, model.id]));
      return id === undefined ? null : harnessModelRefSchema.parse({ id });
    },
  };
}

/** Entry stamps: the message's own number when present, else the entry's ISO stamp. */
function entryTimestampMs(entry: OmoEntry): number | undefined {
  const messageTimestamp = message(entry)?.timestamp;
  if (
    typeof messageTimestamp === "number" &&
    Number.isSafeInteger(messageTimestamp) &&
    messageTimestamp >= 0
  ) {
    return messageTimestamp;
  }
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

/**
 * Projects one Session's history into a Host snapshot. Only Turns on the
 * effective branch appear; a Turn is a user-message entry plus its reply
 * chain (assistant messages, tool results, compactions) up to the next user
 * entry. Leading and in-slice `model_change` entries carry the effective
 * Model forward; `custom`, `thinking_level_change`, `label`, `session_info`
 * and `branch_summary` entries carry no Item.
 */
export function mapOmoSnapshot(
  history: OmoSessionHistory,
  state: OmoHistoryState,
): HostThreadSnapshot {
  if (typeof state.sessionId !== "string" || state.sessionId.trim().length === 0) {
    throw new OmoHistoryProtocolError("OmO history projection requires a Session id");
  }
  const active = activeOmoEntries(history);
  const models = omoHistoryModelIndex([
    ...(state.models ?? []),
    ...(state.model ? [state.model] : []),
    ...active.map(modelChange).filter((model): model is OmoNativeModelRef => model !== null),
  ]);
  let effectiveModel = state.model ?? null;
  const turns: HostThreadSnapshot["turns"] = [];
  for (let index = 0; index < active.length;) {
    const changed = modelChange(active[index] as OmoEntry);
    if (changed) {
      effectiveModel = changed;
      index += 1;
      continue;
    }
    const user = active[index] as OmoEntry;
    if (messageRole(user) !== "user") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < active.length && messageRole(active[end] as OmoEntry) !== "user") end += 1;
    const entries = active.slice(index, end);
    const outcome = assistantOutcome(entries);
    const model = effectiveModel ? models.ref(effectiveModel) : null;
    const startedAtMs = entryTimestampMs(user);
    // The Turn's conversational end: the newest message entry after the user
    // entry. A Turn whose reply has not landed yet gets no completion stamp.
    let completedAtMs: number | undefined;
    for (let scan = end - 1; scan > index; scan -= 1) {
      const candidate = active[scan] as OmoEntry;
      if (message(candidate)) {
        completedAtMs = entryTimestampMs(candidate);
        break;
      }
    }
    turns.push({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: omoHarnessId,
        nativeSessionId: state.sessionId,
        nativeTurnKey: omoHistoryTurnKey(user.id),
        formatVersion: 1,
      }),
      checkpoint: nativeCheckpointRefSchema.parse({
        harnessId: omoHarnessId,
        nativeSessionId: state.sessionId,
        checkpointId: user.id,
        formatVersion: 1,
      }) as NativeCheckpointRef,
      input: [{ type: "text", text: textContent(message(user)?.content) }],
      items: snapshotItems(entries, outcome),
      outcome,
      ...(model ? { model } : {}),
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    });
    for (const entry of entries) {
      const changedInTurn = modelChange(entry);
      if (changedInTurn) effectiveModel = changedInTurn;
    }
    index = end;
  }
  return { turns };
}

/**
 * Reads the Session tree leaf and every entry, in pages. The tree is read
 * first so the leaf's ancestors are always inside the entry pages collected
 * afterwards (see the module doc).
 */
export async function readOmoHistory(
  channel: OmoHistoryChannel,
  options: { timeoutMs?: number } = {},
): Promise<OmoSessionHistory> {
  const leafId = await readOmoLeafId(channel, options);
  const entries = await readAllOmoEntries(channel, options);
  return { entries, leafId };
}

async function readOmoLeafId(
  channel: OmoHistoryChannel,
  options: { timeoutMs?: number },
): Promise<string | null> {
  const response = await channel.send("get_tree", {}, options);
  const data = response.data;
  if (!isRecord(data)) {
    throw new OmoHistoryProtocolError("OmO get_tree response has no object data");
  }
  if (!Array.isArray(data.tree)) {
    throw new OmoHistoryProtocolError("OmO get_tree response has no tree array");
  }
  if (data.leafId !== null && typeof data.leafId !== "string") {
    throw new OmoHistoryProtocolError("OmO get_tree response has an invalid leaf id");
  }
  return data.leafId as string | null;
}

async function readAllOmoEntries(
  channel: OmoHistoryChannel,
  options: { timeoutMs?: number },
): Promise<JsonObject[]> {
  const entries: JsonObject[] = [];
  let limit = OMO_ENTRIES_PAGE_LIMIT;
  let maxBytes = OMO_ENTRIES_PAGE_BYTES;
  let since: string | undefined;
  const cursors = new Set<string>();
  for (;;) {
    let response: OmoResponseFrame;
    try {
      response = await channel.send(
        "get_entries",
        { limit, maxBytes, ...(since === undefined ? {} : { since }) },
        options,
      );
    } catch (error) {
      if (isResponseTooLarge(error)) {
        // Shrink the page first; an Entry larger than the byte bound then
        // needs the protocol's 48 MiB answer cap, and past that no answer can
        // carry it, so the walk ends in a typed error instead of a hang.
        if (limit > 1) {
          limit = Math.max(1, Math.floor(limit / 2));
          continue;
        }
        if (maxBytes < OMO_ENTRIES_MAX_PAGE_BYTES) {
          maxBytes = OMO_ENTRIES_MAX_PAGE_BYTES;
          continue;
        }
        throw new OmoHistoryProtocolError(
          "OmO get_entries refused a one-Entry page at the 48 MiB answer limit",
        );
      }
      throw error;
    }
    const data = response.data;
    if (!isRecord(data) || !Array.isArray(data.entries)) {
      throw new OmoHistoryProtocolError("OmO get_entries response has no Entries array");
    }
    if (typeof data.hasMore !== "boolean") {
      throw new OmoHistoryProtocolError("OmO get_entries page has no hasMore flag");
    }
    for (const value of data.entries) {
      if (!isRecord(value)) {
        throw new OmoHistoryProtocolError("OmO get_entries response contains a non-object Entry");
      }
      // Frames arrive JSON-parsed, so every record value is a JsonValue.
      entries.push(value as JsonObject);
    }
    if (!data.hasMore) break;
    const nextSince = data.nextSince;
    if (typeof nextSince !== "string" || nextSince.length === 0) {
      throw new OmoHistoryProtocolError("OmO get_entries page has no next cursor");
    }
    if (cursors.has(nextSince) || data.entries.length === 0) {
      throw new OmoHistoryProtocolError("OmO get_entries page made no forward progress");
    }
    cursors.add(nextSince);
    since = nextSince;
  }
  return entries;
}

function isResponseTooLarge(error: unknown): boolean {
  return error instanceof OmoRpcResponseError && error.errorCode === "response_too_large";
}

/** Reads the history and projects it in one call; see mapOmoSnapshot. */
export async function readOmoSnapshot(
  channel: OmoHistoryChannel,
  state: OmoHistoryState,
  options: { timeoutMs?: number } = {},
): Promise<HostThreadSnapshot> {
  return mapOmoSnapshot(await readOmoHistory(channel, options), state);
}
