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
type PlanDirection = "plan_mode_handoff" | "plan_mode_handback";

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

function planContinuationType(step: readonly ProtoField[]): PlanDirection | undefined {
  const eventType = textField(nested(step, 114), 3);
  return eventType === "plan_mode_handoff" || eventType === "plan_mode_handback"
    ? eventType
    : undefined;
}

function planToolDirection(toolName: string): PlanDirection | undefined {
  if (toolName === "exit_plan_mode") return "plan_mode_handoff";
  if (toolName === "enter_plan_mode") return "plan_mode_handback";
  return undefined;
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
    const wakeRuns = new Set<string>();
    const planCalls = new Map<string, { direction: PlanDirection; owner: "foreground" | "wake" }>();
    const pendingPlanHandoffs: Array<{ direction: PlanDirection; owner: "foreground" | "wake" }> =
      [];
    let latestOwner: "foreground" | "wake" | undefined;
    let seenUserInput = false;
    const hasMetadata = (db.prepare("PRAGMA table_info(steps)").all() as { name?: unknown }[]).some(
      (column) => column.name === "metadata",
    );
    const resolveRunOwner = (stepRun: string): "foreground" | "wake" | undefined => {
      if (stepRun) {
        if (foregroundRuns.has(stepRun)) return "foreground";
        if (wakeRuns.has(stepRun)) return "wake";
        return undefined;
      }
      return latestOwner;
    };
    for (const row of db
      .prepare(
        `SELECT idx, step_type, status, step_payload${
          hasMetadata
            ? `, CASE WHEN step_type = ${SYSTEM_MESSAGE} THEN metadata END AS metadata`
            : ""
        } FROM steps
         WHERE idx > ? AND step_type IN (${USER_INPUT}, ${PLANNER_RESPONSE}, ${SYSTEM_MESSAGE}, ${GENERIC_TOOL}, ${CHECKPOINT})
         ORDER BY idx`,
      )
      .iterate(afterStepIndex)) {
      const idx = Number(row.idx);
      const step = message(row.step_payload);
      const metadata = nested(step, 5);
      const stepRun = textField(metadata, 12);
      if (row.step_type === USER_INPUT) {
        seenUserInput = true;
        if (stepRun) foregroundRuns.add(stepRun);
        latestOwner = "foreground";
        continue;
      }
      if (IN_FLIGHT.has(Number(row.status))) continue;
      if (row.step_type === SYSTEM_MESSAGE) {
        if (!stepRun) continue;
        const planType = planContinuationType(step);
        if (planType) {
          // A Plan switch stays with the execution that initiated its Plan tool call, never
          // falling through to the in-prompt wake timestamp branch.
          const handoffIndex = pendingPlanHandoffs.findIndex(
            (entry) => entry.direction === planType,
          );
          const resolvedOwner =
            handoffIndex >= 0 ? pendingPlanHandoffs.splice(handoffIndex, 1)[0]?.owner : latestOwner;
          if (row.status === DONE && resolvedOwner === "foreground" && !wakeRuns.has(stepRun)) {
            foregroundRuns.add(stepRun);
            latestOwner = "foreground";
          } else {
            wakeRuns.add(stepRun);
            latestOwner = "wake";
          }
          continue;
        }
        if (foregroundRuns.has(stepRun)) {
          latestOwner = "foreground";
        } else if (
          row.status === DONE &&
          seenUserInput &&
          !wakeRuns.has(stepRun) &&
          inPromptWindow?.(nativeStepCreatedAtMs(row.metadata))
        ) {
          foregroundRuns.add(stepRun);
          latestOwner = "foreground";
        } else {
          wakeRuns.add(stepRun);
          latestOwner = "wake";
        }
        continue;
      }
      if (row.step_type === PLANNER_RESPONSE) {
        const owner = resolveRunOwner(stepRun);
        if (!owner) continue;
        latestOwner = owner;
        const body = nested(step, 20);
        for (const field of body) {
          if (field.number !== 7 || field.wire !== 2) continue;
          const call = message(field.value);
          const toolCallId = textField(call, 1);
          const direction = planToolDirection(textField(call, 2));
          if (toolCallId && direction) planCalls.set(toolCallId, { direction, owner });
        }
        continue;
      }
      if (row.step_type === GENERIC_TOOL) {
        const call = nested(metadata, 4);
        const toolCallId = textField(call, 1);
        const planCall = toolCallId ? planCalls.get(toolCallId) : undefined;
        const owner = planCall?.owner ?? resolveRunOwner(stepRun);
        if (owner) latestOwner = owner;
        if (row.status === DONE) {
          const direction = planCall?.direction ?? planToolDirection(textField(call, 2));
          if (direction && owner) pendingPlanHandoffs.push({ direction, owner });
          if (toolCallId) planCalls.delete(toolCallId);
        }
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
  type OwnerKind = "foreground" | "in-prompt" | "candidate" | "wake";
  interface WakeCandidate {
    stepIndex: number;
    run: string;
    events: NativeReplayEvent[];
    calls: ToolCalls;
    createdAtMs?: number;
  }
  interface ActiveWake {
    eventIndex: number;
    stepIndex: number;
    run: string;
    calls: ToolCalls;
    settled: boolean;
  }
  interface PlanOwnerEntry {
    direction: PlanDirection;
    owner: OwnerKind;
    wake?: ActiveWake;
    candidate?: WakeCandidate;
  }

  const events: NativeReplayEvent[] = [];
  const interleavedPromptSteps = new Map<number, number>();
  let userToolCalls: ToolCalls = new Map();
  let toolCalls: ToolCalls = userToolCalls;
  let foregroundRuns = new Set<string>();
  let inPromptRuns = new Set<string>();
  let planCalls = new Map<string, PlanOwnerEntry>();
  let pendingPlanHandoffs: PlanOwnerEntry[] = [];
  let turnCount = 0;
  let run = "";
  let lastOwner: OwnerKind = "foreground";
  let candidate: WakeCandidate | undefined;
  let wake: ActiveWake | undefined;
  let userInsertIndex: number | undefined;
  let routingToUser = false;
  let finalPlanner = false;
  let currentStepIndex = -1;
  let lastUserStepIndex = -1;

  const isUserOwner = (owner: OwnerKind): boolean =>
    owner === "foreground" || owner === "in-prompt";
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
      foregroundRuns = new Set();
      inPromptRuns = new Set();
      planCalls = new Map();
      pendingPlanHandoffs = [];
      lastOwner = "foreground";
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
      const planType = planContinuationType(step);
      if (planType) {
        // Keep the owner (including an existing wake or foreground/in-prompt run) across the Plan boundary.
        if (stepRun) {
          const handoffIndex = pendingPlanHandoffs.findIndex(
            (entry) => entry.direction === planType,
          );
          const handoff =
            handoffIndex >= 0 ? pendingPlanHandoffs.splice(handoffIndex, 1)[0] : undefined;
          const owner = handoff?.owner ?? lastOwner;
          if (owner === "candidate") {
            const targetCandidate = handoff?.candidate ?? candidate;
            if (targetCandidate) targetCandidate.run = stepRun;
            lastOwner = "candidate";
          } else if (owner === "wake") {
            const targetWake = handoff?.wake ?? wake;
            if (targetWake) {
              targetWake.run = stepRun;
              if (targetWake === wake) run = stepRun;
            } else {
              run = stepRun;
            }
            lastOwner = "wake";
          } else if (owner === "in-prompt") {
            inPromptRuns.add(stepRun);
            if (!wake) run = stepRun;
            lastOwner = "in-prompt";
            if (userInsertIndex !== undefined) recordInterleavedStep(idx);
            else if (turnCount > 0) lastUserStepIndex = Math.max(lastUserStepIndex, idx);
          } else {
            foregroundRuns.add(stepRun);
            if (!wake) run = stepRun;
            lastOwner = "foreground";
            if (userInsertIndex !== undefined) recordInterleavedStep(idx);
            else if (turnCount > 0) lastUserStepIndex = Math.max(lastUserStepIndex, idx);
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
      const knownUserRun = !!stepRun && (inPromptRuns.has(stepRun) || foregroundRuns.has(stepRun));
      if (!knownUserRun && (stepRun ? stepRun !== activeRun : finalPlanner)) {
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
    const isForegroundRun = turnCount > 0 && !!stepRun && foregroundRuns.has(stepRun);
    const belongsToUser = isInPromptRun || isForegroundRun;
    const userRunOwner: OwnerKind = isInPromptRun ? "in-prompt" : "foreground";
    if (row.step_type === CHECKPOINT) {
      const event = decodeCheckpointEvent(idx, row.status, step);
      if (!event) continue;
      if (belongsToUser) {
        lastOwner = userRunOwner;
        pushUserEvent(event);
        continue;
      }
      const pendingWake = candidate?.run === stepRun ? candidate : undefined;
      const activeRun = wake ? wake.run : run;
      if (!pendingWake && (candidate || (stepRun && activeRun && stepRun !== activeRun))) continue;
      if (pendingWake) {
        lastOwner = "candidate";
        pendingWake.events.push(event);
      } else {
        lastOwner = wake ? "wake" : "foreground";
        pushEvent(event, false);
      }
      continue;
    }
    if (row.step_type === USER_INPUT) {
      run = stepRun;
      if (stepRun) foregroundRuns.add(stepRun);
    }
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
        if (belongsToUser) {
          lastOwner = userRunOwner;
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
            const planDir = planToolDirection(name);
            if (planDir) planCalls.set(toolCallId, { direction: planDir, owner: userRunOwner });
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
          const promotedCandidate = candidate;
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
          for (const entry of planCalls.values()) {
            if (entry.candidate === promotedCandidate) {
              entry.owner = "wake";
              entry.wake = wake;
              delete entry.candidate;
            }
          }
          for (const entry of pendingPlanHandoffs) {
            if (entry.candidate === promotedCandidate) {
              entry.owner = "wake";
              entry.wake = wake;
              delete entry.candidate;
            }
          }
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
        const plannerOwner: OwnerKind = wake ? "wake" : "foreground";
        lastOwner = plannerOwner;
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
          const planDir = planToolDirection(name);
          if (planDir) {
            planCalls.set(toolCallId, {
              direction: planDir,
              owner: plannerOwner,
              ...(wake ? { wake } : {}),
            });
          }
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
        if (!belongsToUser && candidate?.run === stepRun) break;
        const warning = textField(nested(body, 3), 2);
        if (warning) {
          lastOwner = belongsToUser ? userRunOwner : wake ? "wake" : "foreground";
          append("agent.text", `⚠ ${warning}`, belongsToUser);
        }
        break;
      }
      case GENERIC_TOOL: {
        const call = nested(metadata, 4);
        const toolCallId = textField(call, 1);
        if (!toolCallId) break;
        // When execution_id is absent on a tool result, resolve unique pending toolCallId ownership.
        let resolvedUser = belongsToUser;
        let resolvedOwner: OwnerKind = belongsToUser ? userRunOwner : wake ? "wake" : "foreground";
        let pendingWake: WakeCandidate | undefined =
          !belongsToUser && candidate?.run === stepRun ? candidate : undefined;
        let calls: ToolCalls = belongsToUser
          ? userToolCalls
          : (pendingWake?.calls ?? wake?.calls ?? toolCalls);
        if (!stepRun) {
          const userPending = turnCount > 0 && userToolCalls.get(toolCallId) === "pending";
          const wakePending = wake?.calls.get(toolCallId) === "pending";
          const candidatePending = candidate?.calls.get(toolCallId) === "pending";
          const matches = Number(userPending) + Number(wakePending) + Number(candidatePending);
          if (matches > 1) break;
          if (matches === 1) {
            if (userPending) {
              resolvedUser = true;
              resolvedOwner =
                planCalls.get(toolCallId)?.owner ?? (isInPromptRun ? "in-prompt" : "foreground");
              pendingWake = undefined;
              calls = userToolCalls;
            } else if (wakePending && wake) {
              resolvedUser = false;
              resolvedOwner = "wake";
              pendingWake = undefined;
              calls = wake.calls;
            } else if (candidatePending && candidate) {
              resolvedUser = false;
              resolvedOwner = "candidate";
              pendingWake = candidate;
              calls = candidate.calls;
            }
          } else if (pendingWake) {
            resolvedOwner = "candidate";
          }
        } else if (pendingWake) {
          resolvedOwner = "candidate";
        }
        const state = calls.get(toolCallId);
        if (state === "settled") break;
        const activeRun = wake ? wake.run : run;
        const name = textField(call, 2);
        if (state === undefined) {
          if (row.status !== DONE || !name) break;
          // A standalone tool (not belonging to an in-prompt wake run) must not extend
          // the previous Turn past a possible fork boundary.
          if (
            !isInPromptRun &&
            !pendingWake &&
            (candidate || (wake && resolvedUser) || (stepRun && activeRun && stepRun !== activeRun))
          )
            break;
          const callEvent: NativeReplayEvent = {
            type: "tool.call",
            toolCallId,
            name,
            args: argsValue(textField(call, 3)),
          };
          if (pendingWake) pendingWake.events.push(callEvent);
          else pushEvent(callEvent, resolvedUser);
        }
        calls.set(toolCallId, "settled");
        const knownPlanCall = planCalls.get(toolCallId);
        if (knownPlanCall) {
          planCalls.delete(toolCallId);
          if (isUserOwner(knownPlanCall.owner)) resolvedOwner = knownPlanCall.owner;
        }
        lastOwner = resolvedOwner;
        if (row.status === DONE) {
          const planDir = knownPlanCall?.direction ?? planToolDirection(name);
          if (planDir) {
            pendingPlanHandoffs.push(
              knownPlanCall ?? {
                direction: planDir,
                owner: resolvedOwner,
                ...(resolvedOwner === "wake" && wake ? { wake } : {}),
                ...(resolvedOwner === "candidate" && pendingWake ? { candidate: pendingWake } : {}),
              },
            );
          }
        }
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
        else pushEvent(updateEvent, resolvedUser);
        break;
      }
    }
  }
  endWake();
  const wakeWatermark =
    events.findLast((event) => event.type === "history.autonomous")?.stepIndex ?? -1;
  return { events, turnCount, wakeWatermark, interleavedPromptSteps };
}
