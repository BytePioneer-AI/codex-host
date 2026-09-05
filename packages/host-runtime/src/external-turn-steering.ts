import type { HarnessResult, HostTextInput, TurnSteerAccepted } from "@codexhost/harness-adapter";
import type { JsonObject } from "@codexhost/protocol-core";
import { hostTurnIdSchema, type HostTurnId } from "@codexhost/shared-contracts";

import {
  createTurnProjectionGate,
  type ExternalThread,
  type TurnProjectionGate,
} from "./external-thread-runtime.js";

interface ParsedSteerInput {
  turnId: HostTurnId;
  input: HostTextInput[];
  clientUserMessageId?: string;
}

export type ExternalTurnSteerOutcome =
  | {
      ok: true;
      turnId: HostTurnId;
      releaseProjectionGate(): void;
    }
  | {
      ok: false;
      code: number;
      message: string;
      releaseProjectionGate(): void;
    };

const releaseImmediately = (): void => undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestSteerInput(params: JsonObject): ParsedSteerInput {
  if (typeof params.expectedTurnId !== "string") {
    throw new Error("turn/steer expectedTurnId must be a string");
  }
  const turnId = hostTurnIdSchema.parse(params.expectedTurnId);
  if (!Array.isArray(params.input) || params.input.length === 0) {
    throw new Error("turn/steer input must be a non-empty array");
  }
  const input = params.input.map((item) => {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
      throw new Error("External turn/steer supports text input only");
    }
    return { type: "text" as const, text: item.text };
  });
  if (!input.some(({ text }) => text.length > 0)) {
    throw new Error("turn/steer must contain text input");
  }
  const clientUserMessageId = params.clientUserMessageId;
  if (
    clientUserMessageId !== undefined &&
    clientUserMessageId !== null &&
    (typeof clientUserMessageId !== "string" ||
      clientUserMessageId.length === 0 ||
      clientUserMessageId.length > 1_024)
  ) {
    throw new Error("turn/steer clientUserMessageId must be a non-empty string");
  }
  return {
    turnId,
    input,
    ...(typeof clientUserMessageId === "string" ? { clientUserMessageId } : {}),
  };
}

function responseGate(thread: ExternalThread, turnId: HostTurnId): TurnProjectionGate {
  const response = createTurnProjectionGate();
  const gate: TurnProjectionGate = {
    promise: Promise.all([
      thread.responseGates.get(turnId)?.promise ?? Promise.resolve(),
      response.promise,
    ]).then(() => undefined),
    resolve: response.resolve,
  };
  thread.responseGates.set(turnId, gate);
  return gate;
}

function failure(
  code: number,
  message: string,
  releaseProjectionGate: () => void = releaseImmediately,
): ExternalTurnSteerOutcome {
  return { ok: false, code, message, releaseProjectionGate };
}

function resultErrorCode(result: Extract<HarnessResult<unknown>, { ok: false }>): number {
  return result.error.code === "unsupported"
    ? -32076
    : result.error.code === "invalidRequest"
      ? -32602
      : result.error.code === "invalidState" || result.error.code === "sessionBusy"
        ? -32074
        : -32073;
}

export async function executeExternalTurnSteer(
  thread: ExternalThread,
  params: JsonObject,
): Promise<ExternalTurnSteerOutcome> {
  let command: ParsedSteerInput;
  try {
    command = requestSteerInput(params);
  } catch (error) {
    return failure(-32602, errorMessage(error));
  }
  if (!thread.session.capabilities.activeTurns?.steer) {
    return failure(-32076, "External Harness does not support turn/steer");
  }
  if (!thread.running || thread.activeTurnId !== command.turnId) {
    return failure(-32074, "External turn/steer must reference the active Turn");
  }
  const projection = thread.projectedTurns.get(command.turnId);
  if (!projection) {
    return failure(-32074, "External turn/steer must reference the active Turn");
  }

  const gate = responseGate(thread, command.turnId);
  try {
    const inputKey = JSON.stringify(command.input);
    let result: HarnessResult<TurnSteerAccepted>;
    const existing = command.clientUserMessageId
      ? projection.steerRequests?.get(command.clientUserMessageId)
      : undefined;
    if (existing) {
      if (existing.inputKey !== inputKey) {
        return failure(
          -32602,
          "turn/steer clientUserMessageId was reused with new input",
          gate.resolve,
        );
      }
      result = await existing.result;
    } else {
      const execution: Promise<HarnessResult<TurnSteerAccepted>> = Promise.resolve()
        .then(() =>
          thread.session.execute({
            type: "turn.steer",
            turnId: command.turnId,
            input: command.input,
            ...(command.clientUserMessageId
              ? { clientUserMessageId: command.clientUserMessageId }
              : {}),
          }),
        )
        .catch((error: unknown) => ({
          ok: false,
          error: {
            code: "internalError",
            message: `External Harness steering failed: ${errorMessage(error)}`,
            retryable: false,
          },
        }));
      if (command.clientUserMessageId) {
        projection.steerRequests ??= new Map();
        projection.steerRequests.set(command.clientUserMessageId, { inputKey, result: execution });
      }
      result = await execution;
    }

    if (!result.ok) {
      return failure(resultErrorCode(result), result.error.message, gate.resolve);
    }
    if (result.value.turnId !== command.turnId) {
      return failure(-32073, "External Harness steering returned a different Turn", gate.resolve);
    }
    return { ok: true, turnId: result.value.turnId, releaseProjectionGate: gate.resolve };
  } catch (error) {
    return failure(
      -32073,
      `External Harness steering failed: ${errorMessage(error)}`,
      gate.resolve,
    );
  }
}
