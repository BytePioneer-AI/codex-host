import { isRecord, nonBlankString } from "../projection.js";
import { redactModernCredential } from "../modern/wire.js";

export type ModernHistoryErrorCode = "limitExceeded" | "protocolError";

export class ModernHistoryError extends Error {
  constructor(
    readonly code: ModernHistoryErrorCode,
    message: string,
  ) {
    super(redactModernCredential(message));
    this.name = "ModernHistoryError";
  }
}

export function validateBaseContent(value: unknown): void {
  if (!Array.isArray(value)) fail("Modern history message content must be an array");
  for (const block of value) {
    if (!isRecord(block) || typeof block.type !== "string") {
      fail("Modern history message contains a malformed content block");
    }
    switch (block.type) {
      case "text":
      case "reasoning":
        exactKeys(block, ["type", "text"]);
        if (typeof block.text !== "string") fail("Modern history text content is malformed");
        break;
      case "image":
        exactKeys(block, ["type", "attachment"]);
        if (!isRecord(block.attachment)) fail("Modern history image content is malformed");
        break;
      case "tool-call":
        exactKeys(block, ["type", "id", "name", "arguments"]);
        requiredString(block.id, "tool-call content id");
        requiredString(block.name, "tool-call content name");
        if (typeof block.arguments !== "string")
          fail("Modern history tool-call content is malformed");
        break;
      default:
        fail("Modern history contains an unknown required content block");
    }
  }
}

export function validateChunk(value: unknown, validateContent: (value: unknown) => void): void {
  if (!isRecord(value) || typeof value.type !== "string") {
    fail("Modern history assistant/chunk is malformed");
  }
  switch (value.type) {
    case "block-start":
      exactKeys(value, ["type", "index", "blockType"]);
      nonNegativeInteger(value.index, "block-start index");
      requiredString(value.blockType, "block-start blockType");
      return;
    case "text-delta":
    case "reasoning-delta":
      exactKeys(value, ["type", "index", "text"]);
      nonNegativeInteger(value.index, "delta index");
      if (typeof value.text !== "string") fail("Modern history text delta is malformed");
      return;
    case "tool-call-delta":
      requiredOptionalKeys(value, ["type", "index", "id", "argumentsDelta"], ["name"]);
      nonNegativeInteger(value.index, "tool-call-delta index");
      requiredString(value.id, "tool-call-delta id");
      if (value.name !== undefined) requiredString(value.name, "tool-call-delta name");
      if (typeof value.argumentsDelta !== "string") {
        fail("Modern history tool-call delta is malformed");
      }
      return;
    case "block-end":
      exactKeys(value, ["type", "index", "block"]);
      nonNegativeInteger(value.index, "block-end index");
      validateContent([value.block]);
      return;
    case "usage":
      exactKeys(value, ["type", "usage"]);
      return;
    case "finish":
      requiredOptionalKeys(value, ["type", "reason"], ["replayState"]);
      if (!isRecord(value.reason) || !requiredString(value.reason.kind, "finish reason kind")) {
        fail("Modern history finish chunk is malformed");
      }
      enumValue(
        value.reason.kind,
        ["stop", "tool-calls", "max-tokens", "aborted", "error"],
        "finish reason kind",
      );
      if (["aborted", "error"].includes(value.reason.kind as string)) {
        validateLlmFailure(value.reason.failure, "finish failure");
      }
      return;
    default:
      fail("Modern history contains an unknown required chunk type");
  }
}

export function validateLlmFailure(value: unknown, label: string): void {
  if (!isRecord(value)) fail(`Modern history ${label} is malformed`);
  requiredOptionalKeys(value, ["message", "code"], ["status", "providerRetryAfterMs", "requestId"]);
  if (typeof value.message !== "string" || typeof value.code !== "string") {
    fail(`Modern history ${label} is malformed`);
  }
  if (value.status !== undefined) nonNegativeInteger(value.status, `${label} status`);
  if (value.providerRetryAfterMs !== undefined) {
    nonNegativeInteger(value.providerRetryAfterMs, `${label} providerRetryAfterMs`);
  }
  if (value.requestId !== undefined) requiredString(value.requestId, `${label} requestId`);
}

export function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`Modern history ${label} is invalid`);
  }
  return value as T;
}

export function exactKeys(value: Record<string, unknown>, required: readonly string[]): void {
  requiredOptionalKeys(value, required, []);
}

export function requiredOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    fail("Modern history known event has an incompatible schema");
  }
}

export function requiredString(value: unknown, label: string): string {
  if (!nonBlankString(value)) fail(`Modern history ${label} is invalid`);
  return value;
}

export function positiveInteger(value: unknown, label: string): number {
  return boundedInteger(value, label, 1);
}

export function nonNegativeInteger(value: unknown, label: string): number {
  return boundedInteger(value, label, 0);
}

export function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function boundedInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

export function fail(message: string, code: ModernHistoryErrorCode = "protocolError"): never {
  throw new ModernHistoryError(code, message);
}
