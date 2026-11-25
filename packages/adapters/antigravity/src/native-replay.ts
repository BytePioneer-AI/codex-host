import type { DatabaseSync } from "node:sqlite";
import type { AntigravityAcpEvent } from "./acp-types.js";
import { readProtoFields, type ProtoField } from "./native-protobuf.js";
import { nativeStepCreatedAtMs } from "./native-request-timing.js";
import { nativeConversationDbPath } from "./native-turn-boundaries.js";
import { isTimestampInPromptWindows, type AntigravityPromptWindow } from "./prompt-windows.js";

export interface DecodeNativeHistoryOptions {
  readonly promptWindows?:
    readonly AntigravityPromptWindow[] | (() => readonly AntigravityPromptWindow[]);
}

export interface NativeCompactionEvent {
  type: "history.compaction";
  stepIndex: number;
  status: "succeeded" | "failed";
  error?: string;
}

/** `createdAtMs` is when the native wake started; absent when the store has no step metadata. */
export type NativeReplayEvent =
  | AntigravityAcpEvent
  | { type: "history.autonomous"; stepIndex: number; createdAtMs?: number }
  | NativeCompactionEvent;

type ToolCalls = Map<string, "pending" | "settled">;

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const ERROR_MESSAGE = 17;
const CHECKPOINT = 23;
const SYSTEM_MESSAGE = 101;
const GENERIC_TOOL = 132;
const DONE = 3;
const ERROR = 7;
const IN_FLIGHT = new Set([1, 2, 8, 9, 11]);

function message(payload: unknown): ProtoField[] {
  const fields = payload instanceof Uint8Array ? readProtoFields(payload) : null;
  if (!fields) throw new Error("Invalid Antigravity history protobuf");
  return fields;
}

function messageField(fields: readonly ProtoField[], number: number): Uint8Array | undefined {
  const field = fields.find((entry) => entry.number === number && entry.wire === 2);
  return field?.value instanceof Uint8Array ? field.value : undefined;
}

function nested(fields: readonly ProtoField[], number: number): ProtoField[] {
  const payload = messageField(fields, number);
  return payload ? message(payload) : [];
}

function textField(fields: readonly ProtoField[], number: number): string {
  const bytes = messageField(fields, number);
  return bytes ? Buffer.from(bytes).toString("utf8") : "";
}

function isPlanContinuation(step: readonly ProtoField[]): boolean {
  const eventType = textField(nested(step, 114), 3);
  return eventType === "plan_mode_handoff" || eventType === "plan_mode_handback";
}

function argsValue(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** Read committed history in step order and feed the same event shapes as the history projector. */
export async function readNativeHistory(
  sessionId: string,
  home: string,
  options?: DecodeNativeHistoryOptions,
): Promise<ReturnType<typeof decodeNativeHistory>> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(sessionId)) throw new Error("Invalid native Session ID");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(nativeConversationDbPath(sessionId, home), { readOnly: true });
  try {
    db.exec("BEGIN");
    return decodeNativeHistory(db, options);
  } finally {
    db.close();
  }
}

/** Read the latest committed step index before a live prompt begins, or -1 if absent. */
export async function readNativeStepWatermark(dbPath: string): Promise<number> {
  const { DatabaseSync } = await import("node:sqlite");
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return -1;
  }
  try {
    db.exec("BEGIN");
    const row = db.prepare("SELECT MAX(idx) AS max_idx FROM steps").get();
    return row?.max_idx === null || row?.max_idx === undefined ? -1 : Number(row.max_idx);
  } catch {
    return -1;
  } finally {
    db.close();
  }
}

function decodeCheckpointEvent(
  idx: number,
  status: unknown,
  step: readonly ProtoField[],
): NativeCompactionEvent | undefined {
  if (status !== DONE && status !== ERROR) return undefined;
  const error = status === ERROR ? nested(step, 31) : [];
  const errorText = textField(error, 3) || textField(error, 2) || textField(error, 1);
  return {
    type: "history.compaction",
    stepIndex: idx,
    status: status === DONE ? "succeeded" : "failed",
    ...(errorText ? { error: errorText } : {}),
  };
}

/** Read terminal compaction checkpoints committed for the active foreground Turn after a watermark. */
export async function readNativeTurnCompactions(
  dbPath: string,
  afterStepIndex: number,
  inPromptWindow?: (createdAtMs: number | undefined) => boolean,
): Promise<NativeCompactionEvent[]> {
  const { DatabaseSync } = await import("node:sqlite");
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    db.exec("BEGIN");
    if (db.prepare("PRAGMA user_version").get()?.user_version !== 1) return [];
    const compactions: NativeCompactionEvent[] = [];
    const foregroundRuns = new Set<string>();
    let latestRun: string | undefined;
    let seenUserInput = false;
    const wakeRuns = new Set<string>();
    const hasMetadata = (db.prepare("PRAGMA table_info(steps)").all() as { name?: unknown }[]).some(
      (column) => column.name === "metadata",
    );
    for (const row of db
      .prepare(
        `SELECT idx, step_type, status, step_payload${
          hasMetadata
            ? `, CASE WHEN step_type = ${SYSTEM_MESSAGE} THEN metadata END AS metadata`
            : ""
        } FROM steps
         WHERE idx > ? AND step_type IN (${USER_INPUT}, ${SYSTEM_MESSAGE}, ${CHECKPOINT})
         ORDER BY idx`,
      )
      .iterate(afterStepIndex)) {
      const idx = Number(row.idx);
      const step = message(row.step_payload);
      const stepRun = textField(nested(step, 5), 12);
      if (row.step_type === USER_INPUT) {
        seenUserInput = true;
        if (stepRun) foregroundRuns.add(stepRun);
        latestRun = stepRun || undefined;
        continue;
      }
      if (row.step_type === SYSTEM_MESSAGE) {
        if (!stepRun) continue;
        if (!foregroundRuns.has(stepRun)) {
          if (isPlanContinuation(step)) {
            // A Plan switch stays with the run that initiated it; never fall through to in-prompt wakes.
            if (
              row.status === DONE &&
              latestRun &&
              foregroundRuns.has(latestRun) &&
              !wakeRuns.has(stepRun)
            ) {
              foregroundRuns.add(stepRun);
            } else wakeRuns.add(stepRun);
          } else if (
            row.status === DONE &&
            seenUserInput &&
            !wakeRuns.has(stepRun) &&
            inPromptWindow?.(nativeStepCreatedAtMs(row.metadata))
          ) {
            foregroundRuns.add(stepRun);
          } else wakeRuns.add(stepRun);
        }
        latestRun = stepRun;
        continue;
      }
      if (!seenUserInput) continue;
      if (stepRun && wakeRuns.has(stepRun)) continue;
      if (stepRun && foregroundRuns.size > 0 && !foregroundRuns.has(stepRun)) continue;
      const event = decodeCheckpointEvent(idx, row.status, step);
      if (event) compactions.push(event);
    }
    return compactions;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function decodeNativeHistory(db: DatabaseSync, options?: DecodeNativeHistoryOptions) {
  const events: NativeReplayEvent[] = [];
  const interleavedPromptSteps = new Map<number, number>();
  let userToolCalls: ToolCalls = new Map();
  let toolCalls: ToolCalls = userToolCalls;
  let inPromptRuns = new Set<string>();
  let turnCount = 0;
  let run = "";
  let lastOwner: "user" | "in-prompt" | "candidate" | "wake" = "user";
  let candidate:
    | {
        stepIndex: number;
        run: string;
        events: NativeReplayEvent[];
        calls: ToolCalls;
        createdAtMs?: number;
      }
    | undefined;
  let wake:
    | {
        eventIndex: number;
        stepIndex: number;
        run: string;
        calls: ToolCalls;
        settled: boolean;
      }
    | undefined;
  let userInsertIndex: number | undefined;
  let routingToUser = false;
  let finalPlanner = false;
  let currentStepIndex = -1;
  let lastUserStepIndex = -1;
  const recordInterleavedStep = (stepIndex: number) => {
    const firstWake = userInsertIndex === undefined ? undefined : events[userInsertIndex];
    if (firstWake?.type === "history.autonomous") {
      const previous = interleavedPromptSteps.get(firstWake.stepIndex);
      if (previous === undefined || stepIndex > previous) {
        interleavedPromptSteps.set(firstWake.stepIndex, stepIndex);
      }
    }
  };
  const endWake = () => {
    if (wake && !wake.settled) {
      events.length = wake.eventIndex;
      interleavedPromptSteps.delete(wake.stepIndex);
    }
    if (userInsertIndex !== undefined && userInsertIndex >= events.length) {
      userInsertIndex = undefined;
      routingToUser = false;
    }
    wake = undefined;
    candidate = undefined;
  };
  const pushUserEvent = (event: NativeReplayEvent) => {
    if (userInsertIndex !== undefined) {
      events.splice(userInsertIndex, 0, event);
      if (wake && userInsertIndex <= wake.eventIndex) wake.eventIndex++;
      userInsertIndex++;
      recordInterleavedStep(currentStepIndex);
    } else {
      events.push(event);
      if (turnCount > 0) lastUserStepIndex = Math.max(lastUserStepIndex, currentStepIndex);
    }
  };
  const pushEvent = (event: NativeReplayEvent, toUser: boolean) => {
    if (toUser) {
      pushUserEvent(event);
    } else {
      events.push(event);
      if (!wake && userInsertIndex === undefined && turnCount > 0) {
        lastUserStepIndex = Math.max(lastUserStepIndex, currentStepIndex);
      }
    }
  };
  const append = (type: "agent.text" | "agent.thought", text: string, toUser: boolean) => {
    if (!text) return;
    const previous =
      toUser && userInsertIndex !== undefined ? events[userInsertIndex - 1] : events.at(-1);
    pushEvent({ type, text: previous?.type === type ? `\n\n${text}` : text }, toUser);
  };
  if (db.prepare("PRAGMA user_version").get()?.user_version !== 1)
    throw new Error("Unsupported Antigravity history database version");
  const promptWindows =
    typeof options?.promptWindows === "function" ? options.promptWindows() : options?.promptWindows;
  const hasMetadata = (db.prepare("PRAGMA table_info(steps)").all() as { name?: unknown }[]).some(
    (column) => column.name === "metadata",
  );
  for (const row of db
    .prepare(
      `SELECT idx, step_type, status, step_payload${
        hasMetadata ? `, CASE WHEN step_type = ${SYSTEM_MESSAGE} THEN metadata END AS metadata` : ""
      } FROM steps
       WHERE step_type IN (${USER_INPUT}, ${PLANNER_RESPONSE}, ${ERROR_MESSAGE}, ${CHECKPOINT}, ${SYSTEM_MESSAGE}, ${GENERIC_TOOL})
       ORDER BY idx`,
    )
    .iterate()) {
    const idx = Number(row.idx);
    currentStepIndex = idx;
    const nativeTurnIndex = row.step_type === USER_INPUT ? turnCount++ : undefined;
    if (nativeTurnIndex !== undefined) {
      endWake();
      run = "";
      inPromptRuns = new Set();
      lastOwner = "user";
      finalPlanner = false;
      userInsertIndex = undefined;
      routingToUser = false;
      lastUserStepIndex = -1;
      userToolCalls = new Map();
      toolCalls = userToolCalls;
    }
    if (IN_FLIGHT.has(Number(row.status))) {
      if (wake && row.step_type === PLANNER_RESPONSE) {
        const inFlightStep = message(row.step_payload);
        const inFlightRun = textField(nested(inFlightStep, 5), 12);
        if (!inFlightRun || inFlightRun === wake.run) wake.settled = false;
      }
      continue;
    }
    const step = message(row.step_payload);
    // CortexStepMetadata.execution_id is shared within an execution, not necessarily a Turn.
    const metadata = nested(step, 5);
    const stepRun = textField(metadata, 12);
    if (row.step_type === SYSTEM_MESSAGE) {
      if (row.status !== DONE) continue;
      if (isPlanContinuation(step)) {
        // Keep the owner (including an existing wake or in-prompt run) across the Plan boundary.
        if (stepRun) {
          if (candidate && lastOwner === "candidate") candidate.run = stepRun;
          else if (wake && lastOwner === "wake") {
            wake.run = stepRun;
            run = stepRun;
          } else if (lastOwner === "in-prompt") {
            inPromptRuns.add(stepRun);
            if (!wake) run = stepRun;
            if (userInsertIndex !== undefined) recordInterleavedStep(idx);
            else if (turnCount > 0) lastUserStepIndex = Math.max(lastUserStepIndex, idx);
          } else {
            run = stepRun;
            if (userInsertIndex === undefined && turnCount > 0)
              lastUserStepIndex = Math.max(lastUserStepIndex, idx);
          }
        }
        continue;
      }
      const createdAtMs = nativeStepCreatedAtMs(row.metadata);
      // A wake that started inside an active user prompt streamed into that Turn; keep it merged
      // even if an independent late-committed wake or unsettled candidate appeared in between.
      if (turnCount > 0 && isTimestampInPromptWindows(createdAtMs, promptWindows)) {
        if (stepRun) inPromptRuns.add(stepRun);
        else endWake();
        routingToUser = userInsertIndex !== undefined;
        lastOwner = "in-prompt";
        if (userInsertIndex !== undefined) recordInterleavedStep(idx);
        else lastUserStepIndex = Math.max(lastUserStepIndex, idx);
        if (!wake) {
          toolCalls = userToolCalls;
          if (stepRun) run = stepRun;
          finalPlanner = false;
        }
        continue;
      }
      const activeRun = wake ? wake.run : run;
      const knownInPromptRun = !!stepRun && inPromptRuns.has(stepRun);
      if (!knownInPromptRun && (stepRun ? stepRun !== activeRun : finalPlanner)) {
        if (candidate?.run !== stepRun) {
          // A new run's in-flight planner must not unsettle the previous wake.
          endWake();
          lastOwner = "candidate";
          candidate = {
            stepIndex: idx,
            run: stepRun,
            events: [],
            calls: new Map(),
            ...(createdAtMs !== undefined ? { createdAtMs } : {}),
          };
        }
      }
      continue;
    }
    const isInPromptRun = turnCount > 0 && (stepRun ? inPromptRuns.has(stepRun) : routingToUser);
    if (row.step_type === CHECKPOINT) {
      const event = decodeCheckpointEvent(idx, row.status, step);
      if (!event) continue;
      if (isInPromptRun) {
        pushUserEvent(event);
        continue;
      }
      const pendingWake = candidate?.run === stepRun ? candidate : undefined;
      const activeRun = wake ? wake.run : run;
      if (!pendingWake && (candidate || (stepRun && activeRun && stepRun !== activeRun))) continue;
      if (pendingWake) pendingWake.events.push(event);
      else pushEvent(event, false);
      continue;
    }
    if (row.step_type === USER_INPUT) run = stepRun;
    const number = row.step_type === USER_INPUT ? 19 : row.step_type === PLANNER_RESPONSE ? 20 : 24;
    const body =
      row.step_type === GENERIC_TOOL ? nested(step, 140) : message(messageField(step, number));
    switch (row.step_type) {
      case USER_INPUT: {
        const items = body.flatMap((field) =>
          field.number === 3 && field.wire === 2 ? [textField(message(field.value), 1)] : [],
        );
        const text = items.join("") || textField(body, 2) || textField(body, 1);
        if (text && nativeTurnIndex !== undefined)
          events.push({ type: "user.text", text, nativeTurnIndex });
        break;
      }
      case PLANNER_RESPONSE: {
        const thought = textField(body, 3);
        const text = textField(body, 1);
        const calls = body.filter((field) => field.number === 7 && field.wire === 2);
        const isFinal = row.status === DONE && !!text.trim() && calls.length === 0;
        if (isInPromptRun) {
          lastOwner = "in-prompt";
          if (!wake && !candidate) {
            if (stepRun) run = stepRun;
            finalPlanner = isFinal;
          }
          append("agent.thought", thought, true);
          append("agent.text", text, true);
          for (const field of body) {
            if (field.number !== 7 || field.wire !== 2) continue;
            const call = message(field.value);
            const toolCallId = textField(call, 1);
            const name = textField(call, 2);
            if (!toolCallId || !name || userToolCalls.get(toolCallId) === "settled") continue;
            userToolCalls.set(toolCallId, "pending");
            pushUserEvent({
              type: "tool.call",
              toolCallId,
              name,
              args: argsValue(textField(call, 3)),
            });
          }
          break;
        }
        if (candidate && candidate.run === stepRun) {
          const { stepIndex, events: earlierTools, calls: earlierCalls, createdAtMs } = candidate;
          endWake();
          routingToUser = false;
          if (turnCount > 0 && userInsertIndex === undefined) userInsertIndex = events.length;
          wake = {
            eventIndex: events.length,
            stepIndex,
            run: stepRun,
            calls: earlierCalls,
            settled: false,
          };
          events.push({
            type: "history.autonomous",
            stepIndex,
            ...(createdAtMs !== undefined ? { createdAtMs } : {}),
          });
          if (turnCount > 0 && lastUserStepIndex >= stepIndex) {
            recordInterleavedStep(lastUserStepIndex);
          }
          for (const event of earlierTools) events.push(event);
          toolCalls = earlierCalls;
        }
        if (stepRun) {
          run = stepRun;
          if (wake) wake.run = stepRun;
        }
        lastOwner = wake ? "wake" : "user";
        finalPlanner = isFinal;
        if (wake) wake.settled = finalPlanner;
        append("agent.thought", thought, false);
        append("agent.text", text, false);
        const activeCalls = wake ? wake.calls : toolCalls;
        for (const field of body) {
          if (field.number !== 7 || field.wire !== 2) continue;
          const call = message(field.value);
          const toolCallId = textField(call, 1);
          const name = textField(call, 2);
          if (!toolCallId || !name || activeCalls.get(toolCallId) === "settled") continue;
          activeCalls.set(toolCallId, "pending");
          pushEvent(
            {
              type: "tool.call",
              toolCallId,
              name,
              args: argsValue(textField(call, 3)),
            },
            false,
          );
        }
        break;
      }
      case ERROR_MESSAGE: {
        // A wake without a final planner reply is not part of the previous Turn.
        if (!isInPromptRun && candidate?.run === stepRun) break;
        const warning = textField(nested(body, 3), 2);
        if (warning) append("agent.text", `⚠ ${warning}`, isInPromptRun);
        break;
      }
      case GENERIC_TOOL: {
        const call = nested(metadata, 4);
        const toolCallId = textField(call, 1);
        if (!toolCallId) break;
        // Tools in a wake candidate belong to that run, but cannot confirm the wake.
        const pendingWake = !isInPromptRun && candidate?.run === stepRun ? candidate : undefined;
        const calls = isInPromptRun
          ? userToolCalls
          : (pendingWake?.calls ?? wake?.calls ?? toolCalls);
        const state = calls.get(toolCallId);
        if (state === "settled") break;
        const activeRun = wake ? wake.run : run;
        if (state === undefined) {
          const name = textField(call, 2);
          if (row.status !== DONE || !name) break;
          // A standalone tool must not extend the previous Turn past a possible fork boundary.
          if (
            !isInPromptRun &&
            !pendingWake &&
            (candidate || (stepRun && activeRun && stepRun !== activeRun))
          )
            break;
          const callEvent: NativeReplayEvent = {
            type: "tool.call",
            toolCallId,
            name,
            args: argsValue(textField(call, 3)),
          };
          if (pendingWake) pendingWake.events.push(callEvent);
          else pushEvent(callEvent, isInPromptRun);
        }
        calls.set(toolCallId, "settled");
        const error = nested(step, 31);
        const output =
          textField(nested(body, 2), 1) ||
          textField(error, 3) ||
          textField(error, 2) ||
          textField(error, 1);
        const status =
          row.status === DONE ? "completed" : row.status === ERROR ? "failed" : "cancelled";
        const updateEvent: NativeReplayEvent = {
          type: "tool.update",
          toolCallId,
          status,
          ...(output ? { rawOutput: output } : {}),
        };
        if (pendingWake) pendingWake.events.push(updateEvent);
        else pushEvent(updateEvent, isInPromptRun);
        break;
      }
    }
  }
  endWake();
  const wakeWatermark =
    events.findLast((event) => event.type === "history.autonomous")?.stepIndex ?? -1;
  return { events, turnCount, wakeWatermark, interleavedPromptSteps };
}
