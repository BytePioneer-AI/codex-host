import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { mergeThreadListPages, listSortSeconds } from "./delegation-thread-list-merge.js";
import { jsonValueSchema } from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import type { SharedThreadBridge } from "./shared-thread-bridge.js";
import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationControlRegistration,
} from "./delegation-types.js";

export const SHARED_DELEGATION_METHOD = "codexhost/shared-threads/delegation";
const operations = [
  "listHarnesses",
  "inspect",
  "start",
  "send",
  "cancel",
  "read",
  "wait",
  "list",
] as const;
type Operation = (typeof operations)[number];

/** The SSH catalog is a proxy; legacy records still use its local coordinator. */
export function sharedDelegationRegistration(
  local: DelegationControlRegistration,
  bridge?: SharedThreadBridge,
): DelegationControlRegistration {
  if (!bridge?.options.delegateCreates) return local;
  const owner = bridge;
  const generation = randomUUID();
  async function call<K extends Operation>(
    operation: K,
    input: Parameters<DelegationControlApi[K]>[0],
  ): Promise<Awaited<ReturnType<DelegationControlApi[K]>>> {
    const response = await owner.request(SHARED_DELEGATION_METHOD, {
      operation,
      input: jsonValueSchema.parse(input ?? {}),
    });
    if (response.error)
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        "Shared delegation request failed; do not retry automatically",
      );
    const result = response.result as {
      value?: Awaited<ReturnType<DelegationControlApi[K]>>;
      error?: {
        code: ConstructorParameters<typeof DelegationControlError>[0];
        message: string;
        details?: Record<string, unknown>;
      };
    };
    if (result.error)
      throw new DelegationControlError(
        result.error.code,
        result.error.message,
        result.error.details,
      );
    if (!Object.hasOwn(result, "value"))
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        "Shared delegation reply is unavailable",
      );
    return result.value as Awaited<ReturnType<DelegationControlApi[K]>>;
  }
  async function thread<K extends "send" | "cancel" | "read" | "wait">(
    operation: K,
    input: Parameters<DelegationControlApi[K]>[0],
  ): Promise<Awaited<ReturnType<DelegationControlApi[K]>>> {
    if ((await owner.ownership([input.threadId])).has(input.threadId))
      return call(operation, input);
    // Each operation keeps its native/local validation and error contract.
    const handler = local[operation] as (
      input: Parameters<DelegationControlApi[K]>[0],
    ) => ReturnType<DelegationControlApi[K]>;
    return await handler(input);
  }
  return {
    ...local,
    ownsThread: async (threadId) =>
      (await owner.ownership([threadId])).has(threadId) || local.ownsThread(threadId),
    canHandleStart: async (input) =>
      (input.parentThreadId !== undefined &&
        (await owner.ownership([input.parentThreadId])).has(input.parentThreadId)) ||
      local.canHandleStart(input),
    list: async (input) => {
      if (!input.parentThreadId) {
        const page = await local.list(input);
        const shared = await owner.ownership(page.threads.map((thread) => thread.threadId));
        return {
          ...page,
          threads: page.threads.map((thread) => {
            const harnessId = shared.get(thread.threadId);
            return harnessId ? { ...thread, harnessId } : thread;
          }),
        };
      }
      return mergeThreadListPages(
        [(page) => local.list(page), (page) => call("list", page)],
        input,
        (a, b) => {
          const field = input.sort.startsWith("created")
            ? "createdAt"
            : input.sort.startsWith("recency")
              ? "recencyAt"
              : "updatedAt";
          const time = (item: typeof a) =>
            listSortSeconds(item, field) ?? listSortSeconds(item, "updatedAt") ?? 0;
          return (
            (input.sort.endsWith("asc") ? 1 : -1) * (time(a) - time(b)) ||
            a.threadId.localeCompare(b.threadId)
          );
        },
        `${generation}:${input.parentThreadId}`,
      );
    },
    listHarnesses: (input) => call("listHarnesses", input),
    inspect: (input) =>
      input.harnessId === "codex" ? local.inspect(input) : call("inspect", input),
    start: async (input) =>
      input.harnessId === "codex" ||
      (input.parentThreadId !== undefined && (await local.ownsThread(input.parentThreadId)))
        ? local.start(input)
        : call("start", input),
    read: (input) => thread("read", input),
    wait: async (input) => {
      if (!(await owner.ownership([input.threadId])).has(input.threadId)) return local.wait(input);
      if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "timeoutMs must be a positive integer",
        );
      const { timeoutMs, ...read } = input;
      const deadline = Date.now() + timeoutMs;
      // Keep each RPC bounded even when the CLI asks to wait longer than a peer timeout.
      for (;;) {
        const snapshot = await call("read", read);
        if (["completed", "failed", "interrupted"].includes(snapshot.status))
          return { ...snapshot, timedOut: false };
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { ...snapshot, timedOut: true };
        await delay(Math.min(100, remaining));
      }
    },
    send: (input) => thread("send", input),
    cancel: (input) => thread("cancel", input),
  };
}

/** Private, authenticated owner transport; coordinator methods validate their inputs. */
export async function dispatchSharedDelegation(api: DelegationControlApi, params: JsonObject) {
  if (
    !operations.includes(params.operation as Operation) ||
    !params.input ||
    typeof params.input !== "object" ||
    Array.isArray(params.input)
  ) {
    return { error: { code: "INVALID_ARGUMENT", message: "Invalid shared delegation operation" } };
  }
  try {
    const operation = params.operation as Operation;
    const handler = api[operation] as (input: unknown) => Promise<unknown>;
    return { value: jsonValueSchema.parse(await handler(params.input)) };
  } catch (error) {
    return {
      error: {
        code: error instanceof DelegationControlError ? error.code : "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof DelegationControlError && error.details
          ? { details: error.details }
          : {}),
      },
    };
  }
}
