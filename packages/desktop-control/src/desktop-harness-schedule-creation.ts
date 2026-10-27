import {
  catalogModelForRef,
  encodeHarnessPluginRoute,
  harnessScheduleInputSchema,
  harnessScheduleRrule,
  hostThreadIdSchema,
  type HarnessInspection,
  type ThreadInspection,
  type HarnessScheduleInput,
  type HarnessScheduleResult,
} from "@codexhost/shared-contracts";

/** One in-memory creation attempt, owned by the mounted Desktop page. */
export interface DesktopHarnessScheduleSession {
  submit(input: HarnessScheduleInput, signal: AbortSignal): Promise<HarnessScheduleResult>;
}

export interface DesktopScheduleServices {
  assertAvailable(): void;
  inspect(input: HarnessScheduleInput): Promise<HarnessInspection>;
  allocate(title: string): Promise<{ cwd: string; workspaceRoot: string }>;
  validateDirectory(cwd: string): Promise<void>;
  createThread(input: {
    cwd: string;
    workspaceRoot: string;
    projectless: boolean;
    model: string;
    title: string;
  }): Promise<unknown>;
  inspectThread(threadId: string): Promise<ThreadInspection>;
  isThreadReady(threadId: string): boolean;
  save(input: {
    kind: "heartbeat";
    name: string;
    prompt: string;
    status: "ACTIVE";
    targetThreadId: string;
    model: null;
    reasoningEffort: null;
    rrule: string;
  }): Promise<unknown>;
  refreshList(): Promise<void>;
}

export class DesktopScheduleRejectedError extends Error {}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const scheduleRrule = harnessScheduleRrule;

/** Page-lifetime state only. A lost write acknowledgement is never replayed. */
export function createDesktopHarnessScheduleSession(
  services: DesktopScheduleServices,
  timeoutMs = 60_000,
): DesktopHarnessScheduleSession {
  let pending: Promise<HarnessScheduleResult> | null = null;
  let inputKey: string | null = null;
  let target: { threadId: ReturnType<typeof hostThreadIdSchema.parse>; cwd: string } | null = null;
  let terminal: HarnessScheduleResult | null = null;
  return {
    submit(raw, signal) {
      if (pending) return pending;
      if (terminal) return Promise.resolve(terminal);
      let input: HarnessScheduleInput;
      try {
        input = harnessScheduleInputSchema.parse(raw);
      } catch {
        return Promise.resolve({
          outcome: "failed",
          retryable: true,
          message: "Invalid schedule fields",
        });
      }
      const key = JSON.stringify(input);
      if (inputKey !== null && key !== inputKey)
        return Promise.resolve({
          outcome: "failed",
          retryable: false,
          ...target,
          message: "Keep this attempt's configuration to retry the existing chat",
        });
      let stopped = false;
      let write: "none" | "workspace" | "thread" | "schedule" = "none";
      let timer: ReturnType<typeof setTimeout>;
      let abort = () => {};
      const check = () => {
        if (stopped || signal.aborted) throw new Error("Creation wait cancelled");
        services.assertAvailable();
      };
      const result = (
        outcome: HarnessScheduleResult["outcome"],
        message?: string,
      ): HarnessScheduleResult => ({
        outcome,
        retryable: outcome === "failed",
        ...target,
        ...(message ? { message } : {}),
      });
      const operation = async (): Promise<HarnessScheduleResult> => {
        try {
          check();
          if (!target) {
            const inspection = await services.inspect(input);
            check();
            if (
              inspection.status !== "ready" ||
              !catalogModelForRef(inspection.catalog, input.model)
            )
              throw new DesktopScheduleRejectedError(
                "The selected Harness or Model is unavailable",
              );
            const title = (input.prompt.split(/\r?\n/u)[0] ?? "").slice(0, 60);
            let cwd = input.cwd?.trim() ?? "";
            let workspaceRoot = cwd;
            if (!cwd) {
              write = "workspace";
              const paths = await services.allocate(title);
              if (
                !record(paths) ||
                typeof paths.cwd !== "string" ||
                !paths.cwd ||
                typeof paths.workspaceRoot !== "string" ||
                !paths.workspaceRoot
              )
                throw new Error("Desktop did not confirm the allocated workspace");
              write = "none";
              check();
              cwd = paths.cwd;
              workspaceRoot = paths.workspaceRoot;
            }
            await services.validateDirectory(cwd);
            check();
            write = "thread";
            const created = await services.createThread({
              cwd,
              workspaceRoot,
              projectless: !input.cwd?.trim(),
              model: encodeHarnessPluginRoute({ harnessId: input.harnessId, model: input.model }),
              title,
            });
            if (record(created) && created.status === "failed") {
              write = "none";
              throw new DesktopScheduleRejectedError(
                typeof created.message === "string" ? created.message : "Chat creation failed",
              );
            }
            if (
              !record(created) ||
              created.status !== "created" ||
              !hostThreadIdSchema.safeParse(created.conversationId).success
            )
              throw new Error("Desktop did not confirm chat creation");
            target = { threadId: hostThreadIdSchema.parse(created.conversationId), cwd };
            inputKey = key;
            write = "none";
            check();
            if (!record(created.firstTurn) || created.firstTurn.status !== "not-requested") {
              terminal = {
                ...result("failed", "Desktop did not finish empty-chat initialization"),
                retryable: false,
              };
              return terminal;
            }
          }
          const ownership = await services.inspectThread(target.threadId);
          check();
          if (
            ownership.owner !== "external" ||
            ownership.harnessId !== input.harnessId ||
            ownership.effectiveModel?.id !== input.model.id ||
            !services.isThreadReady(target.threadId)
          )
            throw new DesktopScheduleRejectedError(
              "The target chat's Harness, Model or Desktop readiness could not be confirmed",
            );
          write = "schedule";
          const saved = await services.save({
            kind: "heartbeat",
            name: (input.prompt.split(/\r?\n/u)[0] ?? "").slice(0, 60),
            prompt: input.prompt,
            status: "ACTIVE",
            targetThreadId: target.threadId,
            model: null,
            reasoningEffort: null,
            rrule: scheduleRrule(input),
          });
          if (
            !record(saved) ||
            !record(saved.item) ||
            typeof saved.item.id !== "string" ||
            saved.item.targetThreadId !== target.threadId ||
            saved.item.kind !== "heartbeat"
          )
            throw new Error("Desktop did not confirm the saved schedule");
          // The native background heartbeat observer reads the official list.
          try {
            await services.refreshList();
          } catch {
            return result(
              "unknown",
              "The schedule was saved, but Desktop's task list could not be refreshed. Check the official task list before creating again.",
            );
          }
          write = "none";
          return result("saved");
        } catch (error) {
          const knownRejection = error instanceof DesktopScheduleRejectedError;
          return result(
            write !== "none" && !knownRejection ? "unknown" : "failed",
            error instanceof Error ? error.message : "Desktop schedule creation failed",
          );
        }
      };
      const interrupted = new Promise<HarnessScheduleResult>((resolve) => {
        abort = () => {
          stopped = true;
          resolve(
            result(
              "unknown",
              "Waiting stopped; submitted operations may still finish. Check the official task list before creating again.",
            ),
          );
        };
        timer = setTimeout(abort, timeoutMs);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      pending = Promise.race([operation(), interrupted])
        .then((value) => {
          if (value.outcome !== "failed") terminal = value;
          return value;
        })
        .finally(() => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          pending = null;
        });
      return pending;
    },
  };
}
