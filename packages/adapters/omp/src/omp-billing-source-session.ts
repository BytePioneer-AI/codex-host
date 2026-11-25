import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { commandInvocation } from "@codexhost/harness-discovery";
import {
  HarnessOutputChannel,
  type BillingSourceOpenResult,
  type BillingSourceSession,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionState,
  type HostCommand,
  type NativeCleanupReceipt,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import type { BillingSourceRef, HarnessModelRef } from "@codexhost/shared-contracts";
import { resolveOmpExecutable, withNodeRuntimeOnPath } from "./command.js";
import { billingSourceExtension } from "./omp-billing-source-extension.js";
import { createOmpModelIndex } from "./omp-model-catalog.js";
import { signalProcessTree } from "./omp-rpc-session.js";
import type { OmpNativeBillingIdentity } from "./omp-account-credits.js";

const commandName = "codexhost-billing-source";
const setupTimeoutMs = 15_000;
const turnTimeoutMs = 30_000;

type Target = { provider: string; credentialId: number; identityKey: string; modelId?: string };
type Receipt = Record<string, unknown>;

export function billingSourceFailure<T>(
  code: "invalidRequest" | "invalidState" | "nativeFailure" | "unsupported",
  message: string,
): HarnessResult<T> {
  return { ok: false, error: { code, message, retryable: false } };
}

export function billingSourceOpenFailure(
  code: "invalidRequest" | "invalidState" | "nativeFailure" | "unsupported",
  message: string,
  nativeCleanup: NativeCleanupReceipt | "unknown" = "not-persisted",
): BillingSourceOpenResult {
  return { ok: false, error: { code, message, retryable: false }, nativeCleanup };
}

interface BridgeOptions {
  command?: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

interface Bridge {
  request(data: Receipt, timeoutMs: number): Promise<Receipt | null>;
  close(): Promise<void>;
}

async function launch(input: BridgeOptions): Promise<Bridge | null> {
  const directory = await mkdtemp(path.join(tmpdir(), "ch-omp-billing-"));
  const extension = path.join(directory, "bridge.mjs");
  const hello = randomUUID();
  try {
    await writeFile(extension, `${billingSourceExtension}\n`, { mode: 0o600, encoding: "utf8" });
    const env = withNodeRuntimeOnPath({
      ...input.environment,
      OMP_SKIP_VERSION_CHECK: "1",
      OMP_TELEMETRY: "0",
      CODEXHOST_OMP_BILLING_HELLO: hello,
    });
    const executable = resolveOmpExecutable({
      ...(input.command ? { command: input.command } : {}),
      environment: env,
    });
    const invocation = commandInvocation(
      executable,
      [
        "--mode",
        "rpc",
        "--no-session",
        "--no-tools",
        "--no-lsp",
        "--no-extensions",
        "--no-ui",
        "--no-skills",
        "--no-rules",
        "--no-context-files",
        "--no-title",
        "--no-prewalk",
        "--offline",
        // Bootstrap the RPC shell without selecting or refreshing a native subscription.
        "--provider",
        "openai",
        "--model",
        "gpt-4.1-mini",
        "--api-key",
        "codexhost-bridge-unused",
        "--extension",
        extension,
      ],
      env,
    );
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: input.cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let pending:
      { id: string; receipt?: Receipt; settle: (receipt: Receipt | null) => void } | undefined;
    let booted = false;
    let advertised = false;
    let dead = false;
    const startup = Promise.withResolvers<undefined>();
    const exited = Promise.withResolvers<undefined>();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let msg: Receipt;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") booted = true;
      if (msg.codexhostBillingSource === hello && msg.code === "registered") advertised = true;
      if (booted && advertised) startup.resolve(undefined);
      if (!pending) return;
      if (msg.codexhostBillingSource === pending.id) pending.receipt = msg;
      if (msg.id !== pending.id) return;
      if (msg.type === "response" && msg.success === false) pending.settle(null);
      if (msg.type === "prompt_result") {
        pending.settle(
          msg.agentInvoked === false && msg.status === "completed"
            ? (pending.receipt ?? null)
            : null,
        );
      }
    });
    child.stdin.on("error", () => pending?.settle(null));
    child.on("error", () => {
      dead = true;
      startup.resolve(undefined);
      pending?.settle(null);
    });
    child.once("close", () => {
      dead = true;
      exited.resolve(undefined);
      startup.resolve(undefined);
      pending?.settle(null);
    });
    function request(data: Receipt, timeoutMs: number): Promise<Receipt | null> {
      if (dead || pending || !child.stdin.writable) return Promise.resolve(null);
      const id = randomUUID();
      const completion = Promise.withResolvers<Receipt | null>();
      const timer = setTimeout(() => pending?.settle(null), timeoutMs);
      pending = {
        id,
        settle: (receipt) => {
          clearTimeout(timer);
          pending = undefined;
          completion.resolve(receipt);
        },
      };
      const args = Buffer.from(JSON.stringify({ ...data, id })).toString("base64url");
      child.stdin.write(
        `${JSON.stringify({ id, type: "prompt", message: `/${commandName} ${args}` })}\n`,
        (error) => {
          if (error && pending?.id === id) pending.settle(null);
        },
      );
      return completion.promise;
    }
    async function close() {
      child.stdin.end();
      const stop = setTimeout(() => {
        if (dead) return;
        try {
          signalProcessTree(child, "SIGKILL");
        } catch {
          /* process exit can race */
        }
      }, 2_000);
      const deadline = Promise.withResolvers<undefined>();
      const timeout = setTimeout(
        () => deadline.reject(new Error("OMP bridge shutdown could not be confirmed")),
        5_000,
      );
      try {
        await Promise.race([exited.promise, deadline.promise]);
      } finally {
        clearTimeout(stop);
        clearTimeout(timeout);
        await rm(directory, { recursive: true, force: true });
      }
    }
    const timeout = setTimeout(() => startup.resolve(undefined), setupTimeoutMs);
    await startup.promise;
    clearTimeout(timeout);
    if (!booted || !advertised || dead) {
      await close();
      return null;
    }
    return { request, close };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function matches(receipt: Receipt, target: Target) {
  return (
    receipt.provider === target.provider &&
    receipt.credentialId === target.credentialId &&
    receipt.identityKey === target.identityKey &&
    (target.modelId === undefined || receipt.modelId === target.modelId)
  );
}

function nativeCleanup(receipt: Receipt | null): NativeCleanupReceipt | "unknown" {
  return receipt?.code === "disposed" &&
    (receipt.cleanup === "deleted" || receipt.cleanup === "not-persisted")
    ? receipt.cleanup
    : "unknown";
}

async function disposeBridge(bridge: Bridge): Promise<NativeCleanupReceipt | "unknown"> {
  try {
    return nativeCleanup(await bridge.request({ type: "dispose" }, setupTimeoutMs));
  } catch {
    return "unknown";
  } finally {
    await bridge.close().catch(() => undefined);
  }
}

export async function listOmpBillingIdentities(
  input: BridgeOptions,
): Promise<readonly OmpNativeBillingIdentity[]> {
  const bridge = await launch(input).catch(() => null);
  if (!bridge) return [];
  try {
    const receipt = await bridge.request({ type: "accounts" }, setupTimeoutMs);
    if (receipt?.code !== "accounts" || !Array.isArray(receipt.accounts)) return [];
    return receipt.accounts.flatMap((value): OmpNativeBillingIdentity[] => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = value as Receipt;
      return typeof row.provider === "string" &&
        row.provider &&
        typeof row.credentialId === "number" &&
        Number.isSafeInteger(row.credentialId) &&
        row.credentialId >= 0 &&
        typeof row.identityKey === "string" &&
        row.identityKey
        ? [{ provider: row.provider, credentialId: row.credentialId, identityKey: row.identityKey }]
        : [];
    });
  } catch {
    return [];
  } finally {
    await bridge.close().catch(() => undefined);
  }
}

export async function openOmpBillingSource(
  input: BridgeOptions & {
    billingSourceRef: BillingSourceRef;
    target: Target;
  },
): Promise<BillingSourceOpenResult> {
  const bridge = await launch(input).catch(() => null);
  if (!bridge)
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: "OMP native Billing Source isolation is unavailable",
        retryable: false,
      },
      nativeCleanup: "not-persisted",
    };
  const ready = await bridge
    .request({ type: "prepare", ...input.target }, setupTimeoutMs)
    .catch(() => null);
  if (
    ready?.code === "ready" &&
    typeof ready.modelId === "string" &&
    matches(ready, input.target) &&
    Array.isArray(ready.modelCollisions)
  ) {
    try {
      const model = { provider: input.target.provider, id: ready.modelId };
      const models = [model];
      for (const pair of ready.modelCollisions) {
        if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
          throw new Error("Invalid OMP Model collision entry");
        }
        models.push({ provider: pair[0], id: pair[1] });
      }
      const effectiveModel = createOmpModelIndex(models).ref(model);
      return {
        ok: true,
        value: new OmpBillingSourceSession(
          bridge,
          input.billingSourceRef,
          { ...input.target, modelId: model.id },
          effectiveModel,
        ),
      };
    } catch {
      // The bridge still belongs to this open until a Session can represent its Model.
    }
  }
  const cleanup = await disposeBridge(bridge);
  return {
    ok: false,
    error: {
      code: cleanup === "unknown" ? "nativeFailure" : "invalidRequest",
      message:
        cleanup === "unknown"
          ? "OMP Billing Source setup and native cleanup could not be confirmed"
          : "OMP Billing Source or its native Model could not be bound",
      retryable: false,
    },
    nativeCleanup: cleanup,
  };
}

class OmpBillingSourceSession implements BillingSourceSession {
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly initialUsage = null;
  readonly capabilities = {
    configuration: {
      selectModel: false,
      selectThinkingOption: false,
      selectPermissionMode: false,
      permissionModeScope: "atCreate" as const,
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  };
  readonly initialState: HarnessSessionState;
  readonly harnessId;
  #turn: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #nativeCleanup: NativeCleanupReceipt | undefined;

  constructor(
    private readonly bridge: Bridge,
    readonly billingSourceRef: BillingSourceRef,
    private readonly target: Required<Target>,
    effectiveModel: HarnessModelRef,
  ) {
    this.harnessId = billingSourceRef.harnessId;
    this.initialState = { effectiveModel };
  }

  async readSnapshot() {
    return { ok: true as const, value: { turns: [], state: this.initialState } };
  }

  execute: HarnessSession["execute"] = (async (command: HostCommand) => {
    if (command.type !== "turn.start")
      return billingSourceFailure(
        "unsupported",
        "OMP Billing Source Sessions only accept their initial Turn",
      );
    return this.#start(command);
  }) as HarnessSession["execute"];

  #start(command: TurnStartCommand): HarnessResult<TurnStartAccepted> {
    if (this.#turn || this.#closing)
      return billingSourceFailure(
        "invalidState",
        "OMP Billing Source Session already used or closed",
      );
    const text = command.input.length === 1 ? command.input[0]?.text : undefined;
    if (!text || !text.trim() || text.length > 512 || text.trimStart().startsWith("/")) {
      return billingSourceFailure(
        "invalidRequest",
        "OMP Billing Source Turn requires one short text input, not a native command",
      );
    }
    const { turnId } = command;
    this.#channel.emit({ kind: "event", event: { type: "turn.started", turnId } });
    this.#turn = this.bridge.request({ type: "turn", text }, turnTimeoutMs).then((receipt) => {
      this.#nativeCleanup =
        (receipt?.code === "completed" || receipt?.code === "failed") &&
        (receipt.cleanup === "deleted" || receipt.cleanup === "not-persisted")
          ? receipt.cleanup
          : undefined;
      const confirmed = receipt?.code === "completed" && matches(receipt, this.target);
      this.#channel.emit({
        kind: "event",
        event: {
          type: "turn.completed",
          turnId,
          ephemeral: true,
          ...(confirmed ? { billingSourceRef: this.billingSourceRef } : {}),
          outcome: confirmed
            ? { status: "succeeded" }
            : {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: "OMP did not confirm the Turn on the requested Billing Source",
                  retryable: false,
                },
              },
        },
      });
    });
    return { ok: true, value: { turnId } };
  }

  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      try {
        if (this.#turn) await this.#turn;
        if (!this.#nativeCleanup) {
          const receipt = await this.bridge.request({ type: "dispose" }, setupTimeoutMs);
          const cleanup = nativeCleanup(receipt);
          this.#nativeCleanup = cleanup === "unknown" ? undefined : cleanup;
        }
        await this.bridge.close();
      } finally {
        this.#channel.end();
      }
    })());
  }

  async confirmNativeCleanup(): Promise<HarnessResult<NativeCleanupReceipt>> {
    if (this.#closing) await this.#closing.catch(() => undefined);
    return this.#closing && this.#nativeCleanup
      ? { ok: true, value: this.#nativeCleanup }
      : billingSourceFailure("nativeFailure", "OMP did not confirm native cleanup");
  }
}
