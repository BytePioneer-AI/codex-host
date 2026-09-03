import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostThreadSnapshot } from "@codexhost/harness-adapter";
import {
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
  nativeTurnRefSchema,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
  type JsonValue,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";
import { z } from "zod";

const HISTORY_VERSION = 1;
const THREAD_ID_ENV = "CODEXHOST_THREAD_ID";

const harnessErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  diagnostic: z.string().optional(),
  stage: z.string().optional(),
  durationMs: z.number().optional(),
  stderrTail: z.string().optional(),
});

const itemOutcomeSchema = z.union([
  z.strictObject({ status: z.literal("succeeded") }),
  z.strictObject({ status: z.literal("failed"), error: harnessErrorSchema }),
  z.strictObject({ status: z.literal("cancelled"), reason: z.string().optional() }),
]);

const textContentSchema = z.strictObject({ type: z.literal("text"), text: z.string() });
const imageContentSchema = z.strictObject({
  type: z.literal("image"),
  mimeType: z.string(),
  base64Data: z.string(),
});
const hostItemSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("agentMessage"), itemId: hostItemIdSchema, text: z.string() }),
  z.strictObject({ type: z.literal("reasoning"), itemId: hostItemIdSchema, text: z.string() }),
  z.strictObject({ type: z.literal("contextCompaction"), itemId: hostItemIdSchema }),
  z.strictObject({
    type: z.literal("commandExecution"),
    itemId: hostItemIdSchema,
    command: z.string(),
    cwd: z.string().optional(),
    output: z.string().optional(),
    outputTruncated: z.boolean().optional(),
    exitCode: z.number().nullable().optional(),
    durationMs: z.number().optional(),
  }),
  z.strictObject({
    type: z.literal("toolExecution"),
    itemId: hostItemIdSchema,
    toolName: z.string(),
    namespace: z.string().optional(),
    arguments: jsonValueSchema,
    output: z
      .strictObject({
        content: z.array(z.union([textContentSchema, imageContentSchema])),
        truncated: z.boolean().optional(),
      })
      .optional(),
    durationMs: z.number().optional(),
  }),
  z.strictObject({
    type: z.literal("fileChange"),
    itemId: hostItemIdSchema,
    changes: z.array(
      z.strictObject({
        path: z.string(),
        kind: z.enum(["add", "update", "delete"]),
        unifiedDiff: z.string(),
      }),
    ),
  }),
  z.strictObject({
    type: z.literal("subagentDelegation"),
    itemId: hostItemIdSchema,
    operation: z.enum(["spawn", "send"]),
    prompt: z.string().optional(),
    subagents: z.array(
      z.strictObject({
        subagentId: z.string(),
        nativeSubagentId: z.string().optional(),
        description: z.string(),
        role: z.string().optional(),
        background: z.boolean(),
        status: z.enum(["pending", "running", "completed", "failed", "interrupted"]),
        resultSummary: z.string().optional(),
      }),
    ),
  }),
]);

const turnOutcomeSchema = z.union([
  z.strictObject({ status: z.literal("succeeded") }),
  z.strictObject({ status: z.literal("failed"), error: harnessErrorSchema }),
  z.strictObject({ status: z.literal("cancelled"), reason: z.string().optional() }),
  z.strictObject({ status: z.literal("unknown"), reason: z.string() }),
]);

const turnSchema = z.strictObject({
  nativeTurnRef: nativeTurnRefSchema,
  input: z.array(z.strictObject({ type: z.literal("text"), text: z.string() })),
  items: z.array(z.strictObject({ item: hostItemSchema, outcome: itemOutcomeSchema })),
  outcome: turnOutcomeSchema,
  model: harnessModelRefSchema.optional(),
});

const historySchema = z.strictObject({
  formatVersion: z.literal(HISTORY_VERSION),
  nativeSessionId: z.string().min(1),
  turns: z.array(turnSchema),
  model: harnessModelRefSchema.optional(),
  thinkingOptionId: harnessThinkingOptionIdSchema.optional(),
});

type AntigravityTurn = HostThreadSnapshot["turns"][number];

function historyRoot(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR;
  return path.join(
    dataDirectory ? path.resolve(dataDirectory) : path.join(os.homedir(), ".codexhost"),
    "antigravity-history",
  );
}

function safeThreadId(environment: NodeJS.ProcessEnv): string | null {
  const threadId = environment[THREAD_ID_ENV]?.trim();
  return threadId && /^[A-Za-z0-9._-]+$/u.test(threadId) ? threadId : null;
}

function historyPath(environment: NodeJS.ProcessEnv): string | null {
  const threadId = safeThreadId(environment);
  return threadId ? path.join(historyRoot(environment), `${threadId}.json`) : null;
}

function jsonTurn(turn: AntigravityTurn): JsonValue {
  return JSON.parse(JSON.stringify(turn)) as JsonValue;
}

export class AntigravityHistory {
  readonly #file: string | null;
  #nativeSessionId: string | null;
  #turns: AntigravityTurn[];
  #model: HarnessModelRef | undefined;
  #thinkingOptionId: HarnessThinkingOptionId | undefined;
  #write: Promise<void> = Promise.resolve();

  private constructor(input: {
    file: string | null;
    nativeSessionId: string | null;
    turns: AntigravityTurn[];
    model?: HarnessModelRef;
    thinkingOptionId?: HarnessThinkingOptionId;
  }) {
    this.#file = input.file;
    this.#nativeSessionId = input.nativeSessionId;
    this.#turns = input.turns;
    this.#model = input.model;
    this.#thinkingOptionId = input.thinkingOptionId;
  }

  static async open(input: {
    environment: NodeJS.ProcessEnv;
    nativeSessionId?: string;
    knownTurnRefs?: NativeTurnRef[];
  }): Promise<AntigravityHistory> {
    const file = historyPath(input.environment);
    const nativeSessionId = input.nativeSessionId ?? null;
    let turns: AntigravityTurn[] = [];
    let model: HarnessModelRef | undefined;
    let thinkingOptionId: HarnessThinkingOptionId | undefined;
    if (file && nativeSessionId) {
      try {
        const parsed = historySchema.safeParse(JSON.parse(await readFile(file, "utf8")));
        if (parsed.success && parsed.data.nativeSessionId === nativeSessionId) {
          turns = parsed.data.turns as AntigravityTurn[];
          model = parsed.data.model;
          thinkingOptionId = parsed.data.thinkingOptionId;
        }
      } catch {
        // A missing or corrupt sidecar cannot safely be treated as Native history.
      }
    }
    if (turns.length === 0 && input.knownTurnRefs) {
      turns = input.knownTurnRefs.map((nativeTurnRef) => ({
        nativeTurnRef,
        input: [],
        items: [],
        outcome: {
          status: "unknown",
          reason: "Antigravity CLI does not expose persisted assistant history to headless clients",
        },
      }));
    }
    return new AntigravityHistory({
      file,
      nativeSessionId,
      turns,
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
    });
  }

  get model(): HarnessModelRef | undefined {
    return this.#model;
  }

  get thinkingOptionId(): HarnessThinkingOptionId | undefined {
    return this.#thinkingOptionId;
  }

  snapshot(): AntigravityTurn[] {
    return [...this.#turns];
  }

  bindNativeSession(nativeSessionId: string): void {
    if (this.#nativeSessionId && this.#nativeSessionId !== nativeSessionId) {
      this.#turns = [];
    }
    this.#nativeSessionId = nativeSessionId;
    this.#queueWrite();
  }

  setSelection(
    model: HarnessModelRef | undefined,
    thinkingOptionId: HarnessThinkingOptionId | undefined,
  ): void {
    this.#model = model;
    this.#thinkingOptionId = thinkingOptionId;
    this.#queueWrite();
  }

  append(input: {
    nativeTurnRef: NativeTurnRef;
    turnInput: AntigravityTurn["input"];
    items: AntigravityTurn["items"];
    outcome: AntigravityTurn["outcome"];
    model?: HarnessModelRef;
  }): void {
    const turn: AntigravityTurn = {
      nativeTurnRef: input.nativeTurnRef,
      input: input.turnInput,
      items: input.items,
      outcome: input.outcome,
      ...(input.model ? { model: input.model } : {}),
    };
    const index = this.#turns.findIndex(
      ({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey === input.nativeTurnRef.nativeTurnKey,
    );
    if (index >= 0) this.#turns[index] = turn;
    else this.#turns.push(turn);
    this.#queueWrite();
  }

  async flush(): Promise<void> {
    await this.#write;
  }

  #queueWrite(): void {
    if (!this.#file || !this.#nativeSessionId) return;
    const file = this.#file;
    const nativeSessionId = this.#nativeSessionId;
    const turns = this.#turns.map(jsonTurn);
    const model = this.#model;
    const thinkingOptionId = this.#thinkingOptionId;
    this.#write = this.#write
      .catch(() => undefined)
      .then(async () => {
        const directory = path.dirname(file);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
        try {
          await writeFile(
            temporary,
            `${JSON.stringify({
              formatVersion: HISTORY_VERSION,
              nativeSessionId,
              turns,
              ...(model ? { model } : {}),
              ...(thinkingOptionId ? { thinkingOptionId } : {}),
            })}\n`,
            { mode: 0o600 },
          );
          await rename(temporary, file);
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      });
  }
}
