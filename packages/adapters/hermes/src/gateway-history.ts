import { spawn } from "node:child_process";
import type {
  HarnessErrorCode,
  HostItemSnapshot,
  HostThreadSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type NativeCheckpointRef,
  type NativeSessionRef,
  type JsonValue,
} from "@codexhost/shared-contracts";
import { GATEWAY_HISTORY_SCRIPT } from "./gateway-history-script.js";

type Row = Record<string, unknown>;
export interface GatewayHistoryData {
  rows: Row[];
  derivable: boolean;
  boundaries: Record<string, { count: number; digest: string }>;
}
function record(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => text(record(part).text)).join("\n");
  return "";
}
function parsed(value: unknown): JsonValue {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return value;
    }
  }
  return (value ?? null) as JsonValue;
}

/** Display history uses native row identities, including original compacted tail IDs. */
export function projectGatewayHistory(
  sessionId: string,
  data: GatewayHistoryData,
): HostThreadSnapshot {
  const turns: HostTurnSnapshot[] = [];
  let turn: HostTurnSnapshot | undefined;
  const tools = new Map<string, HostItemSnapshot>();
  for (const row of data.rows) {
    if (!Number.isSafeInteger(row.id) || !Number.isSafeInteger(row.original_id))
      throw new Error("Hermes history has no durable message identity");
    const id = String(row.original_id);
    if (row.role === "user") {
      if (typeof row.user_text !== "string") continue;
      tools.clear();
      const boundary = data.derivable ? data.boundaries[String(row.id)] : undefined;
      turn = {
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId: "hermes",
          nativeSessionId: sessionId,
          nativeTurnKey: id,
          formatVersion: 1,
        }),
        ...(boundary
          ? {
              checkpoint: nativeCheckpointRefSchema.parse({
                harnessId: "hermes",
                nativeSessionId: sessionId,
                checkpointId: String(row.id),
                formatVersion: 1,
                locator: boundary,
              }),
            }
          : {}),
        input: [{ type: "text", text: row.user_text }],
        items: [],
        outcome: {
          status: "unknown",
          reason: "Hermes persisted history does not record a turn outcome",
        },
        ...(typeof row.timestamp === "number"
          ? { startedAtMs: Math.trunc(row.timestamp * 1000) }
          : {}),
      };
      turns.push(turn);
      continue;
    }
    if (!turn) continue;
    const itemId = (suffix: string) => hostItemIdSchema.parse(`hermes:${id}:${suffix}`);
    if (row.role === "assistant") {
      const reasoning =
        row.display_visible === false ? "" : text(row.reasoning_content) || text(row.reasoning);
      if (reasoning)
        turn.items.push({
          item: { type: "reasoning", itemId: itemId("reasoning"), text: reasoning },
          outcome: { status: "succeeded" },
        });
      const content = typeof row.display_text === "string" ? row.display_text : text(row.content);
      if (content)
        turn.items.push({
          item: { type: "agentMessage", itemId: itemId("message"), text: content },
          outcome: { status: "succeeded" },
        });
      if (Array.isArray(row.tool_calls))
        for (const value of row.tool_calls) {
          const call = record(value);
          const fn = record(call.function);
          if (typeof call.id !== "string" || typeof fn.name !== "string") continue;
          // Only persisted results establish a completed tool Item. A call with no
          // result remains absent instead of inventing a successful execution.
          tools.set(call.id, {
            item: {
              type: "toolExecution",
              itemId: itemId(`tool:${call.id}`),
              toolName: fn.name,
              arguments: parsed(fn.arguments),
            },
            outcome: { status: "succeeded" },
          });
        }
    } else if (row.role === "tool" && typeof row.tool_call_id === "string") {
      const tool = tools.get(row.tool_call_id);
      if (!tool || tool.item.type !== "toolExecution") continue;
      const output =
        typeof row.content === "string" ? row.content : JSON.stringify(row.content ?? "");
      tool.item.output = { content: [{ type: "text", text: output }] };
      const result = record(parsed(row.content));
      if (result.is_error === true || result.isError === true || result.error)
        tool.outcome = {
          status: "failed",
          error: {
            code: "nativeFailure",
            message:
              typeof result.error === "string" ? result.error : "Hermes tool reported an error",
            retryable: false,
          },
        };
      turn.items.push(tool);
      tools.delete(row.tool_call_id);
    }
  }
  return { turns };
}

export interface HermesGatewayHistoryOptions {
  python: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  nativeSessionId: string;
}
export class HermesGatewayHistoryError extends Error {
  constructor(
    readonly code: HarnessErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class HermesGatewayHistory {
  #derived = new Map<string, string>();
  constructor(readonly options: HermesGatewayHistoryOptions) {}

  async readSnapshot(): Promise<HostThreadSnapshot> {
    const data = await this.#run({ operation: "read" });
    if (!Array.isArray(data.rows) || typeof data.derivable !== "boolean" || !data.boundaries)
      throw new Error("Malformed Hermes native history response");
    return projectGatewayHistory(
      this.options.nativeSessionId,
      data as unknown as GatewayHistoryData,
    );
  }

  async resolvePhysicalSessionId(): Promise<string> {
    const data = await this.#run({ operation: "resolve" });
    if (typeof data.physicalSessionId !== "string")
      throw new Error("Missing Hermes storage identity");
    return data.physicalSessionId;
  }

  async ensureCreated(input: {
    cwd: string;
    model?: string;
    provider?: string;
    reasoningEffort?: string;
    yolo?: boolean;
  }): Promise<void> {
    await this.#run({ operation: "ensure", ...input });
  }

  async derive(
    input: { checkpoint?: NativeCheckpointRef; rollbackLastTurn?: true } = {},
  ): Promise<NativeSessionRef> {
    if (input.checkpoint && input.rollbackLastTurn)
      throw new Error("Conflicting Hermes derivation boundaries");
    if (
      input.checkpoint &&
      (input.checkpoint.harnessId !== "hermes" ||
        input.checkpoint.nativeSessionId !== this.options.nativeSessionId)
    )
      throw new Error("Hermes checkpoint belongs to another session");
    const data = await this.#run({ operation: "derive", ...input });
    const ref = nativeSessionRefSchema.parse({
      harnessId: "hermes",
      nativeSessionId: data.sessionId,
      formatVersion: 1,
      locator: { transport: "gateway" },
    });
    if (typeof data.digest !== "string") throw new Error("Missing Hermes derived-history proof");
    this.#derived.set(ref.nativeSessionId, data.digest);
    return ref;
  }

  async discardDerived(ref: NativeSessionRef): Promise<boolean> {
    const expectedDigest = this.#derived.get(ref.nativeSessionId);
    if (
      ref.harnessId !== "hermes" ||
      ref.nativeSessionId === this.options.nativeSessionId ||
      !expectedDigest
    )
      throw new HermesGatewayHistoryError(
        "invalidRequest",
        "This history reader did not create the derived Hermes session",
      );
    const result = await this.#run({
      operation: "discard",
      derivedSessionId: ref.nativeSessionId,
      expectedDigest,
    });
    if (result.deleted === true) this.#derived.delete(ref.nativeSessionId);
    return result.deleted === true;
  }

  #run(input: Row): Promise<Row> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.python, ["-I", "-u", "-c", GATEWAY_HISTORY_SCRIPT], {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.environment },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      // Do not expose stderr: native exceptions may contain transcript or configuration data.
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Hermes history operation timed out"));
      }, 30_000);
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("Cannot start Hermes native history reader"));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 32 * 1024 * 1024) {
          child.kill();
          reject(new Error("Hermes native history exceeds the supported size"));
        }
      });
      child.stderr.resume();
      child.stdin.on("error", () => undefined);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0)
          return reject(
            new Error("Hermes native history operation failed; source history was not modified"),
          );
        try {
          const value = record(JSON.parse(stdout.trim()));
          const error = record(value.error);
          if (["unsupported", "checkpointNotFound", "invalidState"].includes(String(error.code))) {
            reject(
              new HermesGatewayHistoryError(error.code as HarnessErrorCode, String(error.message)),
            );
          } else resolve(value);
        } catch {
          reject(new Error("Malformed Hermes native history response"));
        }
      });
      child.stdin.end(JSON.stringify({ ...input, sessionId: this.options.nativeSessionId }));
    });
  }
}
