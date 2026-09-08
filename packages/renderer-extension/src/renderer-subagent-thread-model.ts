export interface SubagentThreadModel {
  model?: string;
  reasoningEffort?: string;
}

export interface RendererThreadRequestTarget {
  sendRequest(method: string, params: unknown): Promise<unknown> | unknown;
}

export interface SubagentActivityHistoryResolver {
  get(threadId: string): readonly unknown[] | undefined;
  ensure(threadId: string): void;
  refresh(threadId: string): void;
  dispose(): void;
}

export type SubagentThreadStatus = "waiting" | "running" | "completed" | "failed" | "interrupted";

export interface SubagentThreadStatusResolver {
  get(threadId: string): SubagentThreadStatus | undefined;
  ensure(threadId: string): void;
  refresh(): void;
  dispose(): void;
}

interface RendererSubagentModelWindow {
  __codexhostDraftPrewarmPolicyV1?: {
    requestTarget?: () => unknown;
  };
}

export interface SubagentThreadModelResolver {
  get(threadId: string): SubagentThreadModel | undefined;
  ensure(threadId: string): void;
  refresh(): void;
  dispose(): void;
}

export interface CreateSubagentThreadModelResolverOptions {
  read(threadId: string): Promise<SubagentThreadModel | null>;
  onUpdate(): void;
  maxAttempts?: number;
  retryDelayMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function rendererThreadRequestTarget(): RendererThreadRequestTarget | null {
  if (typeof window === "undefined") return null;
  const policy = (window as unknown as RendererSubagentModelWindow).__codexhostDraftPrewarmPolicyV1;
  if (typeof policy?.requestTarget !== "function") return null;
  try {
    const target = policy.requestTarget();
    return isRecord(target) && typeof target.sendRequest === "function"
      ? (target as unknown as RendererThreadRequestTarget)
      : null;
  } catch {
    return null;
  }
}

export function subagentThreadModelFromReadResult(
  value: unknown,
  expectedThreadId?: string,
): SubagentThreadModel | null {
  if (!isRecord(value)) return null;
  const directThread = isRecord(value.thread) ? value.thread : null;
  const nestedThread =
    isRecord(value.result) && isRecord(value.result.thread) ? value.result.thread : null;
  const thread = directThread ?? nestedThread;
  if (!thread) return null;
  if (expectedThreadId && (!nonBlank(thread.id) || thread.id.trim() !== expectedThreadId)) {
    return null;
  }
  const model = nonBlank(thread.model)
    ? thread.model.trim()
    : nonBlank(thread.latestModel)
      ? thread.latestModel.trim()
      : undefined;
  const reasoningEffort = nonBlank(thread.reasoningEffort)
    ? thread.reasoningEffort.trim()
    : nonBlank(thread.latestReasoningEffort)
      ? thread.latestReasoningEffort.trim()
      : undefined;
  if (!model && !reasoningEffort) return null;
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export async function readRendererSubagentThreadModel(
  threadId: string,
): Promise<SubagentThreadModel | null> {
  const target = rendererThreadRequestTarget();
  if (!target) return null;
  return readSubagentThreadModelFromTarget(target, threadId);
}

export async function readSubagentThreadModelFromTarget(
  target: RendererThreadRequestTarget,
  threadId: string,
): Promise<SubagentThreadModel | null> {
  const result = await target.sendRequest("thread/read", {
    threadId,
    includeTurns: false,
  });
  return subagentThreadModelFromReadResult(result, threadId);
}

export function subagentActivitiesFromReadResult(
  value: unknown,
  expectedThreadId: string,
): readonly unknown[] | null {
  if (!isRecord(value)) return null;
  const directThread = isRecord(value.thread) ? value.thread : null;
  const nestedThread =
    isRecord(value.result) && isRecord(value.result.thread) ? value.result.thread : null;
  const thread = directThread ?? nestedThread;
  if (!thread || !nonBlank(thread.id) || thread.id.trim() !== expectedThreadId) return null;
  if (!Array.isArray(thread.turns)) return [];
  return thread.turns.flatMap((turn) => {
    if (!isRecord(turn) || !Array.isArray(turn.items)) return [];
    return turn.items.filter((item) => isRecord(item) && item.type === "subAgentActivity");
  });
}

export async function readRendererSubagentActivities(
  threadId: string,
): Promise<readonly unknown[] | null> {
  const target = rendererThreadRequestTarget();
  if (!target) return null;
  return readSubagentActivitiesFromTarget(target, threadId);
}

export async function readSubagentActivitiesFromTarget(
  target: RendererThreadRequestTarget,
  threadId: string,
): Promise<readonly unknown[] | null> {
  const result = await target.sendRequest("thread/read", {
    threadId,
    includeTurns: true,
  });
  return subagentActivitiesFromReadResult(result, threadId);
}

export function subagentStatusFromReadResult(
  value: unknown,
  expectedThreadId: string,
): SubagentThreadStatus | null {
  if (!isRecord(value)) return null;
  const directThread = isRecord(value.thread) ? value.thread : null;
  const nestedThread =
    isRecord(value.result) && isRecord(value.result.thread) ? value.result.thread : null;
  const thread = directThread ?? nestedThread;
  if (!thread || !nonBlank(thread.id) || thread.id.trim() !== expectedThreadId) return null;
  const threadStatus =
    isRecord(thread.status) && nonBlank(thread.status.type) ? thread.status.type : undefined;
  if (threadStatus === "systemError") return "failed";
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const lastTurn = [...turns].reverse().find(isRecord);
  const turnStatus = lastTurn && nonBlank(lastTurn.status) ? lastTurn.status : undefined;
  if (turnStatus === "completed") return "completed";
  if (turnStatus === "failed") return "failed";
  if (turnStatus === "interrupted" || turnStatus === "cancelled") return "interrupted";
  if (turnStatus === "inProgress" || turnStatus === "running") return "running";
  if (turnStatus === "pending" || turnStatus === "queued") return "waiting";
  if (threadStatus === "active") return "running";
  return null;
}

export async function readRendererSubagentStatus(
  threadId: string,
): Promise<SubagentThreadStatus | null> {
  const target = rendererThreadRequestTarget();
  if (!target) return null;
  const result = await target.sendRequest("thread/read", {
    threadId,
    includeTurns: true,
  });
  return subagentStatusFromReadResult(result, threadId);
}

export function createSubagentThreadModelResolver(
  options: CreateSubagentThreadModelResolverOptions,
): SubagentThreadModelResolver {
  const models = new Map<string, SubagentThreadModel>();
  const pending = new Set<string>();
  const attempts = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  let disposed = false;

  const ensure = (threadId: string): void => {
    if (disposed || !threadId || models.has(threadId) || pending.has(threadId)) return;
    const attempt = (attempts.get(threadId) ?? 0) + 1;
    if (attempt > maxAttempts) return;
    attempts.set(threadId, attempt);
    pending.add(threadId);
    void options
      .read(threadId)
      .then(
        (snapshot) => {
          if (disposed) return;
          if (snapshot) {
            models.set(threadId, snapshot);
            attempts.delete(threadId);
            options.onUpdate();
            return;
          }
          if (attempt >= maxAttempts || retryTimers.has(threadId)) return;
          retryTimers.set(
            threadId,
            setTimeout(() => {
              retryTimers.delete(threadId);
              ensure(threadId);
            }, retryDelayMs),
          );
        },
        () => {
          if (disposed || attempt >= maxAttempts || retryTimers.has(threadId)) return;
          retryTimers.set(
            threadId,
            setTimeout(() => {
              retryTimers.delete(threadId);
              ensure(threadId);
            }, retryDelayMs),
          );
        },
      )
      .finally(() => {
        pending.delete(threadId);
      });
  };

  return {
    get(threadId) {
      return models.get(threadId);
    },
    ensure,
    refresh() {
      if (disposed) return;
      for (const threadId of [...attempts.keys()]) {
        if (pending.has(threadId) || retryTimers.has(threadId)) continue;
        attempts.delete(threadId);
        ensure(threadId);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      pending.clear();
      attempts.clear();
      models.clear();
    },
  };
}

export function createSubagentActivityHistoryResolver(options: {
  read(threadId: string): Promise<readonly unknown[] | null>;
  onUpdate(): void;
  maxAttempts?: number;
  retryDelayMs?: number;
}): SubagentActivityHistoryResolver {
  const activities = new Map<string, readonly unknown[]>();
  const pending = new Set<string>();
  const attempts = new Map<string, number>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  let disposed = false;

  const ensure = (threadId: string): void => {
    if (disposed || !threadId || activities.has(threadId) || pending.has(threadId)) return;
    const attempt = (attempts.get(threadId) ?? 0) + 1;
    if (attempt > maxAttempts) return;
    attempts.set(threadId, attempt);
    pending.add(threadId);
    void options
      .read(threadId)
      .then((items) => {
        if (disposed) return;
        if (items) {
          activities.set(threadId, items);
          attempts.delete(threadId);
          options.onUpdate();
          return;
        }
        if (attempt >= maxAttempts || retries.has(threadId)) return;
        retries.set(
          threadId,
          setTimeout(() => {
            retries.delete(threadId);
            ensure(threadId);
          }, retryDelayMs),
        );
      })
      .catch(() => {
        if (disposed || attempt >= maxAttempts || retries.has(threadId)) return;
        retries.set(
          threadId,
          setTimeout(() => {
            retries.delete(threadId);
            ensure(threadId);
          }, retryDelayMs),
        );
      })
      .finally(() => {
        pending.delete(threadId);
      });
  };

  return {
    get(threadId) {
      return activities.get(threadId);
    },
    ensure,
    refresh(threadId) {
      if (disposed || !threadId) return;
      activities.delete(threadId);
      const retry = retries.get(threadId);
      if (retry) clearTimeout(retry);
      retries.delete(threadId);
      attempts.delete(threadId);
      ensure(threadId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of retries.values()) clearTimeout(timer);
      retries.clear();
      pending.clear();
      attempts.clear();
      activities.clear();
    },
  };
}

export function createSubagentThreadStatusResolver(options: {
  read(threadId: string): Promise<SubagentThreadStatus | null>;
  onUpdate(): void;
  maxAttempts?: number;
}): SubagentThreadStatusResolver {
  const statuses = new Map<string, SubagentThreadStatus>();
  const pending = new Set<string>();
  const attempts = new Map<string, number>();
  const maxAttempts = options.maxAttempts ?? 3;
  let disposed = false;

  const ensure = (threadId: string): void => {
    const current = statuses.get(threadId);
    if (
      disposed ||
      !threadId ||
      pending.has(threadId) ||
      current === "completed" ||
      current === "failed" ||
      current === "interrupted"
    ) {
      return;
    }
    const attempt = (attempts.get(threadId) ?? 0) + 1;
    if (attempt > maxAttempts) return;
    attempts.set(threadId, attempt);
    pending.add(threadId);
    void options
      .read(threadId)
      .then((status) => {
        if (disposed || !status) return;
        statuses.set(threadId, status);
        if (status === "completed" || status === "failed" || status === "interrupted") {
          attempts.delete(threadId);
        }
        options.onUpdate();
      })
      .catch(() => {})
      .finally(() => {
        pending.delete(threadId);
      });
  };

  return {
    get(threadId) {
      return statuses.get(threadId);
    },
    ensure,
    refresh() {
      if (disposed) return;
      for (const threadId of new Set([...statuses.keys(), ...attempts.keys()])) {
        const status = statuses.get(threadId);
        if (status === "completed" || status === "failed" || status === "interrupted") continue;
        attempts.delete(threadId);
        ensure(threadId);
      }
    },
    dispose() {
      disposed = true;
      statuses.clear();
      attempts.clear();
      pending.clear();
    },
  };
}
