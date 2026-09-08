import path from "node:path";

import type {
  HarnessAdapter,
  HarnessError,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  HarnessSubagentCapability,
  HostThreadSnapshot,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import {
  harnessInspectionSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";

import { resolveMuseExecutable } from "./command.js";
import { readMuseChildHistory, snapshotFromMuseHistory } from "./history.js";
import {
  decodeMuseThinkingOptionId,
  parseMuseModelCatalog,
  type MuseModelRow,
} from "./model-catalog.js";
import {
  MuseProcessError,
  MuseRpcError,
  MuseServeClient,
  type JsonObject,
  type MuseRpc,
} from "./msp-client.js";
import {
  MUSE_HARNESS_ID,
  MUSE_SESSION_CAPABILITIES,
  MuseHarnessSession,
  nativeSessionFromResult,
} from "./muse-session.js";
import {
  MUSE_PERMISSION_MODE_CATALOG,
  musePermissionModeForExecutionPolicy,
} from "./permission-modes.js";
import { uuidv7 } from "./uuid.js";

export interface MuseAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  serveExtraArguments?: string[];
  createRpc?: (input: {
    executable: string;
    cwd: string;
    environment: NodeJS.ProcessEnv;
  }) => Promise<MuseRpc> | MuseRpc;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateNativeReferences(input: OpenSessionInput): HarnessError | undefined {
  if (input.kind !== "resume" && input.kind !== "fork") return undefined;
  const source = nativeSessionRefSchema.safeParse(
    input.kind === "resume" ? input.nativeRef : input.sourceRef,
  );
  if (
    !source.success ||
    source.data.harnessId !== MUSE_HARNESS_ID ||
    source.data.formatVersion !== 1
  ) {
    return {
      code: "invalidRequest",
      message: "Muse Session reference is invalid or belongs to another Harness",
      retryable: false,
    };
  }
  if (input.kind === "fork") {
    const checkpoint = nativeCheckpointRefSchema.safeParse(input.checkpoint);
    if (
      !checkpoint.success ||
      checkpoint.data.harnessId !== MUSE_HARNESS_ID ||
      checkpoint.data.nativeSessionId !== source.data.nativeSessionId ||
      checkpoint.data.formatVersion !== source.data.formatVersion
    ) {
      return {
        code: "invalidRequest",
        message: "Muse Fork checkpoint does not belong to the source Session",
        retryable: false,
      };
    }
  }
  return undefined;
}

function inspectionError(error: unknown, stage: string): HarnessInspection {
  if (error instanceof MuseProcessError) {
    return { status: "error", error: { ...error.harnessError, stage } };
  }
  if (error instanceof MuseRpcError) {
    return {
      status: "error",
      error: { code: "protocolError", message: error.message, retryable: true, stage },
    };
  }
  return {
    status: "error",
    error: {
      code: "internalError",
      message: error instanceof Error ? error.message : "Muse inspect failed",
      retryable: true,
      stage,
    },
  };
}

export class MuseAdapter implements HarnessAdapter {
  readonly harnessId = MUSE_HARNESS_ID;
  readonly subagents: HarnessSubagentCapability = {
    readSnapshot: async (input) => this.#readSubagentSnapshot(input),
  };
  #command?: string;
  #environment: NodeJS.ProcessEnv;
  #serveExtraArguments: string[];
  #createRpc: MuseAdapterOptions["createRpc"];
  #closed = false;
  #sessions = new Set<MuseHarnessSession>();

  constructor(options: MuseAdapterOptions = {}) {
    if (options.command) this.#command = options.command;
    this.#environment = options.environment ?? process.env;
    this.#serveExtraArguments = options.serveExtraArguments ?? [];
    this.#createRpc = options.createRpc;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed) {
      return {
        status: "unavailable",
        error: { code: "invalidState", message: "Muse Adapter is closed", retryable: false },
      };
    }
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const executable = resolveMuseExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    if (!executable) {
      return {
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: "Meta Muse Code CLI (muse) is not installed",
          retryable: false,
        },
      };
    }
    let rpc: MuseRpc | undefined;
    try {
      rpc = await this.#openRpc(executable, cwd, this.#environment);
      await rpc.handshake();
      const listed = await rpc.request("model/list");
      const rows = Array.isArray(listed.models)
        ? listed.models.filter(isRecord).map((row): MuseModelRow => ({
            modelId: String(row.modelId ?? ""),
            displayLabel: String(row.displayLabel ?? row.modelId ?? ""),
            ...(typeof row.providerId === "string" ? { providerId: row.providerId } : {}),
            ...(row.isDefault === true ? { isDefault: true } : {}),
          }))
        : [];
      return harnessInspectionSchema.parse({
        status: "ready",
        catalog: parseMuseModelCatalog(rows),
        permissionModes: MUSE_PERMISSION_MODE_CATALOG,
        capabilities: MUSE_SESSION_CAPABILITIES,
      });
    } catch (error) {
      return inspectionError(error, "model-catalog");
    } finally {
      await rpc?.close();
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) {
      return {
        ok: false,
        error: { code: "invalidState", message: "Muse Adapter is closed", retryable: false },
      };
    }
    if (input.kind === "rollbackLastTurn") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Muse does not support last-turn rollback",
          retryable: false,
        },
      };
    }
    if (input.kind === "create" && input.executionPolicy === "unattended-full-access") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message:
            "Muse serve does not support unattended full-access delegation under its startup policy; open an interactive Muse Thread instead",
          retryable: false,
        },
      };
    }
    const referenceError = validateNativeReferences(input);
    if (referenceError) return { ok: false, error: referenceError };
    const executable = resolveMuseExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: { ...this.#environment, ...input.environment },
    });
    if (!executable) {
      return {
        ok: false,
        error: {
          code: "notInstalled",
          message: "Meta Muse Code CLI (muse) is not installed",
          retryable: false,
        },
      };
    }
    const environment = { ...this.#environment, ...input.environment };
    let rpc: MuseRpc | undefined;
    let adopted = false;
    try {
      if (input.kind === "create") {
        musePermissionModeForExecutionPolicy(input.executionPolicy, input.permissionModeId);
        if (input.thinkingOptionId) decodeMuseThinkingOptionId(input.thinkingOptionId);
      }
      rpc = await this.#openRpc(executable, input.cwd, environment);
      this.#assertOpen();
      await rpc.handshake();
      this.#assertOpen();
      if (input.kind === "create") {
        const approvalMode = musePermissionModeForExecutionPolicy(
          input.executionPolicy,
          input.permissionModeId,
        );
        const result = await rpc.request("session/start", {
          commandId: uuidv7(),
          workspaceRoot: path.resolve(input.cwd),
          // Preserve the native startup default when no mode was selected.
          ...(input.permissionModeId ? { approvalMode } : {}),
          ...(input.model ? { modelId: input.model.id } : {}),
        });
        this.#assertOpen();
        const session = new MuseHarnessSession({
          rpc,
          native: nativeSessionFromResult(result),
          ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
        });
        this.#sessions.add(session);
        adopted = true;
        return { ok: true, value: session };
      }
      if (input.kind === "resume") {
        const result = await rpc.request("session/resume", {
          commandId: uuidv7(),
          sessionId: input.nativeRef.nativeSessionId,
          excludeItems: true,
        });
        this.#assertOpen();
        const native = nativeSessionFromResult(result);
        if (native.sessionId !== input.nativeRef.nativeSessionId) {
          return {
            ok: false,
            error: {
              code: "sessionNotFound",
              message: "Muse resumed a different Session",
              retryable: false,
            },
          };
        }
        const resumed = isRecord(result.session) ? result.session : result;
        if (
          resumed.status === "running" ||
          (typeof resumed.activeTurnId === "string" && resumed.activeTurnId.length > 0) ||
          (Array.isArray(result.pendingRequests) && result.pendingRequests.length > 0)
        ) {
          return {
            ok: false,
            error: {
              code: "sessionBusy",
              message: "Muse Session still has an active Turn or pending interaction",
              retryable: true,
            },
          };
        }
        const session = new MuseHarnessSession({
          rpc,
          native,
        });
        this.#sessions.add(session);
        adopted = true;
        return { ok: true, value: session };
      }
      const result = await rpc.request("session/fork", {
        commandId: uuidv7(),
        sessionId: input.sourceRef.nativeSessionId,
        cutPoint: { lastTurnId: input.checkpoint.checkpointId },
        excludeItems: true,
      });
      this.#assertOpen();
      const session = new MuseHarnessSession({
        rpc,
        native: nativeSessionFromResult(result),
      });
      this.#sessions.add(session);
      adopted = true;
      return { ok: true, value: session };
    } catch (error) {
      if (error instanceof MuseProcessError) return { ok: false, error: error.harnessError };
      if (error instanceof MuseRpcError) {
        return {
          ok: false,
          error: { code: "nativeFailure", message: error.message, retryable: false },
        };
      }
      return {
        ok: false,
        error: {
          code: "internalError",
          message: error instanceof Error ? error.message : "Muse failed to open a Session",
          retryable: false,
        },
      };
    } finally {
      if (rpc && !adopted) {
        // Preserve the original open failure if native cleanup also fails.
        await rpc.close().catch(() => undefined);
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new MuseProcessError({
        code: "invalidState",
        message: "Muse Adapter is closed",
        retryable: false,
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#sessions].map((session) => session.close()));
    this.#sessions.clear();
  }

  async #readSubagentSnapshot(input: {
    parent: { harnessId: string; nativeSessionId: string; formatVersion: number };
    nativeSubagentId: string;
    cwd: string;
  }): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) {
      return {
        ok: false,
        error: { code: "invalidState", message: "Muse Adapter is closed", retryable: false },
      };
    }
    if (input.parent.harnessId !== MUSE_HARNESS_ID || input.nativeSubagentId.trim().length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Muse Subagent reference is invalid",
          retryable: false,
        },
      };
    }
    const executable = resolveMuseExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    if (!executable) {
      return {
        ok: false,
        error: {
          code: "notInstalled",
          message: "Meta Muse Code CLI (muse) is not installed",
          retryable: false,
        },
      };
    }
    let rpc: MuseRpc | undefined;
    try {
      rpc = await this.#openRpc(executable, path.resolve(input.cwd), this.#environment);
      await rpc.handshake();
      const history = await readMuseChildHistory(
        rpc,
        input.parent.nativeSessionId,
        input.nativeSubagentId,
      );
      const parentRef = nativeSessionRefSchema.parse({
        harnessId: MUSE_HARNESS_ID,
        nativeSessionId: input.parent.nativeSessionId,
        formatVersion: input.parent.formatVersion,
      });
      return { ok: true, value: snapshotFromMuseHistory(parentRef, history) };
    } catch (error) {
      if (error instanceof MuseProcessError) return { ok: false, error: error.harnessError };
      if (error instanceof MuseRpcError) {
        return {
          ok: false,
          error: { code: "nativeFailure", message: error.message, retryable: false },
        };
      }
      return {
        ok: false,
        error: {
          code: "internalError",
          message: error instanceof Error ? error.message : "Muse Subagent history failed",
          retryable: false,
        },
      };
    } finally {
      await rpc?.close();
    }
  }

  async #openRpc(
    executable: string,
    cwd: string,
    environment: NodeJS.ProcessEnv,
  ): Promise<MuseRpc> {
    if (this.#createRpc) return this.#createRpc({ executable, cwd, environment });
    return new MuseServeClient({
      executable,
      cwd,
      environment,
      ...(this.#serveExtraArguments.length > 0
        ? { extraArguments: this.#serveExtraArguments }
        : {}),
    });
  }
}
