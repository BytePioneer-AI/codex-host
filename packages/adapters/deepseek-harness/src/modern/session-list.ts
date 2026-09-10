import { Buffer } from "node:buffer";
import path from "node:path";

import {
  DEEPSEEK_MODERN_SESSION_CWD_MAX_LENGTH,
  DEEPSEEK_MODERN_SESSION_ID_MAX_LENGTH,
  DEEPSEEK_MODERN_SESSION_LIST_MAX_LENGTH,
  DEEPSEEK_MODERN_SESSION_TITLE_MAX_LENGTH,
  DEEPSEEK_MODERN_SESSION_UPDATED_AT_MAX,
  type DeepSeekModernSessionCandidate,
} from "@codexhost/shared-contracts";

import { ModernRemoteConnectionError } from "./remote-connection.js";
import {
  redactModernCredential,
  sanitizeModernRemoteFailure,
  type ModernRemoteResult,
} from "./wire.js";

const MAX_SESSION_LIST_BYTES = 32 * 1024 * 1024;
const MAX_SESSION_LIST_DEPTH = 64;
const MAX_SESSION_LIST_NODES = 200_000;

export type ModernSessionListErrorCode =
  | "authenticationRequired"
  | "cancelled"
  | "limitExceeded"
  | "notInstalled"
  | "processExited"
  | "protocolError"
  | "remoteError"
  | "unavailable";

export class ModernSessionListError extends Error {
  readonly nativeCode?: string;

  constructor(
    readonly code: ModernSessionListErrorCode,
    message: string,
    nativeCode?: string,
  ) {
    super(redactModernCredential(message));
    this.name = "ModernSessionListError";
    if (nativeCode !== undefined) this.nativeCode = redactModernCredential(nativeCode);
  }
}

export interface ModernSessionListRemote {
  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ModernRemoteResult<T>>;
}

interface ParsedSessionSummary {
  readonly sessionId: string;
  readonly updatedAt: number;
  readonly running: boolean;
  readonly blank: boolean;
  readonly origin?: "subagent";
  readonly cwd?: string;
  readonly title: string | null;
}

function sessionListError(
  code: ModernSessionListErrorCode,
  message: string,
  nativeCode?: string,
): ModernSessionListError {
  return new ModernSessionListError(code, message, nativeCode);
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
  const ancestors = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (depth > MAX_SESSION_LIST_DEPTH || nodes > MAX_SESSION_LIST_NODES) {
      throw sessionListError("limitExceeded", "DeepSeek Harness Session list exceeded its bound");
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "string" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return;
    }
    if (typeof candidate !== "object" || ancestors.has(candidate)) {
      throw sessionListError("protocolError", "DeepSeek Harness returned an invalid Session list");
    }
    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
    } else {
      if (!isPlainRecord(candidate)) {
        throw sessionListError(
          "protocolError",
          "DeepSeek Harness returned an invalid Session list",
        );
      }
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== "string") {
          throw sessionListError(
            "protocolError",
            "DeepSeek Harness returned an invalid Session list",
          );
        }
        visit(candidate[key], depth + 1);
      }
    }
    ancestors.delete(candidate);
  };
  visit(value, 0);

  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw sessionListError("protocolError", "DeepSeek Harness returned an invalid Session list");
  }
  if (text === undefined) {
    throw sessionListError("protocolError", "DeepSeek Harness returned an invalid Session list");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SESSION_LIST_BYTES) {
    throw sessionListError(
      "limitExceeded",
      "DeepSeek Harness Session list exceeded its byte bound",
    );
  }
}

function boundedId(value: unknown, area: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    value.length > DEEPSEEK_MODERN_SESSION_ID_MAX_LENGTH
  ) {
    throw sessionListError("protocolError", `DeepSeek Harness returned an invalid ${area}`);
  }
  return value;
}

function validUpdatedAt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= DEEPSEEK_MODERN_SESSION_UPDATED_AT_MAX &&
    !Object.is(value, -0)
  );
}

function titleFromProjections(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, ["asOfSeq", "values"]) ||
    !Number.isSafeInteger(value.asOfSeq) ||
    (value.asOfSeq as number) < -1 ||
    !isPlainRecord(value.values)
  ) {
    throw sessionListError(
      "protocolError",
      "DeepSeek Harness returned invalid Session list projections",
    );
  }
  const title = value.values.title;
  return typeof title === "string" &&
    title.trim().length > 0 &&
    title.length <= DEEPSEEK_MODERN_SESSION_TITLE_MAX_LENGTH &&
    !title.includes("\0")
    ? title
    : null;
}

function parseSummary(value: unknown): ParsedSessionSummary {
  if (
    !isPlainRecord(value) ||
    !exactKeys(
      value,
      ["sessionId", "updatedAt", "running", "blank"],
      ["parentSessionId", "origin", "cwd", "projections"],
    ) ||
    typeof value.running !== "boolean" ||
    typeof value.blank !== "boolean" ||
    !validUpdatedAt(value.updatedAt)
  ) {
    throw sessionListError("protocolError", "DeepSeek Harness returned an invalid Session row");
  }
  const sessionId = boundedId(value.sessionId, "Session id");
  if (value.parentSessionId !== undefined) {
    boundedId(value.parentSessionId, "parent Session id");
  }
  if (value.origin !== undefined && value.origin !== "subagent") {
    throw sessionListError("protocolError", "DeepSeek Harness returned an invalid Session origin");
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    throw sessionListError("protocolError", "DeepSeek Harness returned an invalid Session cwd");
  }
  if (typeof value.cwd === "string" && value.cwd.length > DEEPSEEK_MODERN_SESSION_CWD_MAX_LENGTH) {
    throw sessionListError("limitExceeded", "DeepSeek Harness Session cwd exceeded its bound");
  }
  return {
    sessionId,
    updatedAt: value.updatedAt,
    running: value.running,
    blank: value.blank,
    ...(value.origin === undefined ? {} : { origin: value.origin }),
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    title: titleFromProjections(value.projections),
  };
}

function isCanonicalAbsoluteCwd(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

/** Strictly parse and filter one exact rc.1 Modern `session/list` value. */
export function parseModernSessionCandidates(value: unknown): DeepSeekModernSessionCandidate[] {
  assertBoundedJson(value);
  if (!isPlainRecord(value) || !exactKeys(value, ["items"]) || !Array.isArray(value.items)) {
    throw sessionListError("protocolError", "DeepSeek Harness returned an invalid Session list");
  }
  if (value.items.length > DEEPSEEK_MODERN_SESSION_LIST_MAX_LENGTH) {
    throw sessionListError(
      "limitExceeded",
      "DeepSeek Harness Session list exceeded its item bound",
    );
  }

  const seen = new Set<string>();
  const summaries = value.items.map((item) => {
    const summary = parseSummary(item);
    if (seen.has(summary.sessionId)) {
      throw sessionListError(
        "protocolError",
        "DeepSeek Harness returned duplicate Session identities",
      );
    }
    seen.add(summary.sessionId);
    return summary;
  });

  return summaries.flatMap((summary) => {
    if (summary.origin === "subagent" || summary.blank || !isCanonicalAbsoluteCwd(summary.cwd)) {
      return [];
    }
    return [
      {
        nativeSessionId: summary.sessionId,
        title: summary.title,
        updatedAt: summary.updatedAt,
        cwd: summary.cwd,
        running: summary.running,
      } satisfies DeepSeekModernSessionCandidate,
    ];
  });
}

/** Read eligible import candidates without activating a Modern Session. */
export async function loadModernSessionCandidates(
  remote: ModernSessionListRemote,
  signal?: AbortSignal,
): Promise<DeepSeekModernSessionCandidate[]> {
  try {
    const result = await remote.call<unknown>("session/list", { _request: {} }, signal);
    if (!result.ok) {
      const safe = sanitizeModernRemoteFailure(result.error);
      throw sessionListError(
        "remoteError",
        `DeepSeek Harness session/list failed: ${safe.message}`,
        safe.code,
      );
    }
    return parseModernSessionCandidates(result.value);
  } catch (error) {
    if (error instanceof ModernSessionListError) throw error;
    if (error instanceof ModernRemoteConnectionError) {
      throw sessionListError(
        error.code,
        `DeepSeek Harness session/list request failed: ${error.message}`,
        error.nativeCode,
      );
    }
    const code =
      typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    throw sessionListError(
      code === "cancelled" ? "cancelled" : "unavailable",
      "DeepSeek Harness session/list request failed",
    );
  }
}
