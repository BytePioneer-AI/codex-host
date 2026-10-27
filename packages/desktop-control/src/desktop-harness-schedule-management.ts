import {
  harnessScheduleEditSchema,
  harnessScheduleRrule,
  hostThreadIdSchema,
  parseHarnessScheduleTime,
  type HarnessSchedule,
  type HarnessScheduleEdit,
  type HarnessScheduleList,
  type HarnessScheduleReference,
  type HarnessScheduleResult,
  type ThreadOwnership,
} from "@codexhost/shared-contracts";
import type { DesktopHarnessScheduleSession } from "./desktop-harness-schedule-creation.js";

export interface DesktopHarnessSchedules {
  createSession(): DesktopHarnessScheduleSession;
  list(signal: AbortSignal): Promise<HarnessScheduleList>;
  update(
    target: HarnessScheduleReference,
    edit: HarnessScheduleEdit,
    signal: AbortSignal,
  ): Promise<HarnessScheduleResult>;
  setStatus(
    target: HarnessScheduleReference,
    status: HarnessSchedule["status"],
    signal: AbortSignal,
  ): Promise<HarnessScheduleResult>;
  delete(target: HarnessScheduleReference, signal: AbortSignal): Promise<HarnessScheduleResult>;
}
export interface DesktopScheduleManagementServices {
  assertAvailable(): void;
  listAutomations(): Promise<unknown>;
  readOwnership(threadId: string): Promise<ThreadOwnership>;
  updateAutomation(input: Record<string, unknown>): Promise<unknown>;
  deleteAutomation(id: string): Promise<unknown>;
  refreshList(): Promise<void>;
}
type NativeHeartbeat = Omit<HarnessSchedule, "harnessId"> & { notificationPolicy?: unknown };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
function localHeartbeat(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    value.kind === "heartbeat" &&
    value.status !== "DELETED" &&
    [value.hostId, value.executor, value.executionEnvironment, value.source].every(
      (field) => field == null || field === "local",
    )
  );
}
function heartbeat(value: Record<string, unknown>): NativeHeartbeat {
  const thread = hostThreadIdSchema.safeParse(value.targetThreadId);
  if (
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.name !== "string" ||
    typeof value.prompt !== "string" ||
    typeof value.rrule !== "string" ||
    !thread.success ||
    (value.status !== "ACTIVE" && value.status !== "PAUSED") ||
    value.model != null ||
    value.reasoningEffort != null
  )
    throw new Error("Unsupported heartbeat shape");
  return {
    id: value.id,
    targetThreadId: thread.data,
    name: value.name,
    prompt: value.prompt,
    rrule: value.rrule,
    status: value.status,
    notificationPolicy: value.notificationPolicy,
  };
}

/** Fixed local heartbeat operations. Desktop remains the only schedule store. */
export function createDesktopScheduleManagement(
  services: DesktopScheduleManagementServices,
  timeoutMs = 60_000,
): Omit<DesktopHarnessSchedules, "createSession"> {
  let pending = false;
  let writeGeneration = 0;
  const uncertain = new Set<string>();
  const check = (signal: AbortSignal) => {
    signal.throwIfAborted();
    services.assertAvailable();
  };
  const readRows = async (signal: AbortSignal) => {
    check(signal);
    const value = await services.listAutomations();
    check(signal);
    if (!record(value) || !Array.isArray(value.items))
      throw new Error("Desktop task list could not be read");
    return value.items as unknown[];
  };
  const owned = async (item: NativeHeartbeat, signal: AbortSignal) => {
    const owner = await services.readOwnership(item.targetThreadId);
    check(signal);
    if (owner.threadId !== item.targetThreadId)
      throw new Error("Thread ownership response does not match");
    if (owner.owner === "codex") return "codex";
    if (owner.owner === "external" && owner.harnessId !== "codex") return owner.harnessId;
    throw new Error("Thread ownership is inconsistent");
  };
  const list = async (signal: AbortSignal): Promise<HarnessScheduleList> => {
    const generation = writeGeneration;
    const startedIdle = !pending;
    const canReconcile = () => startedIdle && !pending && generation === writeGeneration;
    const rows = await readRows(signal);
    const items: HarnessSchedule[] = [];
    let unresolved = 0;
    const counts = new Map<string, number>();
    for (const row of rows)
      if (record(row) && typeof row.id === "string")
        counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    for (const row of rows) {
      if (!record(row)) {
        unresolved += 1;
        continue;
      }
      if (!localHeartbeat(row)) continue;
      try {
        const item = heartbeat(row);
        if (counts.get(item.id) !== 1) throw new Error("Ambiguous automation identity");
        const harnessId = await owned(item, signal);
        if (harnessId) {
          const { notificationPolicy: _notificationPolicy, ...display } = item;
          void _notificationPolicy;
          items.push({ ...display, harnessId });
        }
        if (canReconcile()) uncertain.delete(item.id);
      } catch {
        check(signal);
        unresolved += 1;
      }
    }
    // Only an explicit successful read clears a lost write acknowledgement.
    if (canReconcile())
      for (const id of uncertain) {
        if (!rows.some((row) => record(row) && row.id === id)) uncertain.delete(id);
      }
    return { items, unresolved };
  };
  const change = (
    target: HarnessScheduleReference,
    edit: HarnessScheduleEdit | null,
    status: HarnessSchedule["status"] | undefined,
    signal: AbortSignal,
  ): Promise<HarnessScheduleResult> => {
    const result = (
      outcome: HarnessScheduleResult["outcome"],
      message?: string,
    ): HarnessScheduleResult => ({
      outcome,
      retryable: outcome === "failed",
      ...(message ? { message } : {}),
    });
    if (uncertain.has(target.id))
      return Promise.resolve(
        result("unknown", "Refresh the task list to check the previous operation"),
      );
    if (pending) return Promise.resolve(result("failed", "A task operation is already pending"));
    pending = true;
    writeGeneration += 1;
    let dispatched = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let abort = () => {};
    const assertCurrent = () => {
      check(signal);
      if (stopped) throw new Error("Task operation wait stopped");
    };
    const operation = async (): Promise<HarnessScheduleResult> => {
      try {
        const patch = edit === null ? null : harnessScheduleEditSchema.parse(edit);
        if (status !== undefined && status !== "ACTIVE" && status !== "PAUSED")
          throw new Error("Invalid task status");
        const rows = (await readRows(signal)).filter((row) => record(row) && row.id === target.id);
        if (rows.length !== 1 || !localHeartbeat(rows[0]))
          throw new Error("This task is not a local heartbeat");
        const current = heartbeat(rows[0]);
        if (current.targetThreadId !== target.targetThreadId || !(await owned(current, signal)))
          throw new Error("The task's Thread ownership could not be confirmed");
        if (patch?.schedule && !parseHarnessScheduleTime(current.rrule))
          throw new Error("Edit this task's complex schedule in the official task list");
        assertCurrent();
        const parameters = {
          id: current.id,
          kind: "heartbeat",
          targetThreadId: current.targetThreadId,
          name: patch?.name ?? current.name,
          prompt: patch?.prompt ?? current.prompt,
          status: status ?? current.status,
          rrule: patch?.schedule ? harnessScheduleRrule(patch.schedule) : current.rrule,
          model: null,
          reasoningEffort: null,
          notificationPolicy: current.notificationPolicy ?? null,
        };
        dispatched = true;
        const response =
          patch === null
            ? await services.deleteAutomation(current.id)
            : await services.updateAutomation(parameters);
        if (patch === null) {
          if (
            !record(response) ||
            response.success !== true ||
            !["deleted", "not_found"].includes(String(response.status))
          )
            throw new Error("Desktop did not confirm deletion");
        } else {
          if (
            !record(response) ||
            !record(response.item) ||
            response.item.id !== current.id ||
            response.item.kind !== "heartbeat" ||
            response.item.targetThreadId !== current.targetThreadId ||
            response.item.name !== parameters.name ||
            response.item.prompt !== parameters.prompt ||
            response.item.status !== parameters.status ||
            response.item.rrule !== parameters.rrule
          )
            throw new Error("Desktop did not confirm the task update");
        }
        await services.refreshList();
        return result("saved");
      } catch (error) {
        if (dispatched) uncertain.add(target.id);
        return result(
          dispatched ? "unknown" : "failed",
          error instanceof Error ? error.message : "Task operation failed",
        );
      } finally {
        pending = false;
      }
    };
    const interrupted = new Promise<HarnessScheduleResult>((resolve) => {
      abort = () => {
        stopped = true;
        if (dispatched) uncertain.add(target.id);
        resolve(
          result(
            dispatched ? "unknown" : "failed",
            "Waiting stopped; refresh to check the task before trying again",
          ),
        );
      };
      timer = setTimeout(abort, timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    return Promise.race([operation(), interrupted]).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    });
  };
  return {
    list,
    update: (target, edit, signal) => change(target, edit, undefined, signal),
    setStatus: (target, status, signal) => change(target, {}, status, signal),
    delete: (target, signal) => change(target, null, undefined, signal),
  };
}
