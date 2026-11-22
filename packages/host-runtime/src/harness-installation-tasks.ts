import { randomUUID } from "node:crypto";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  harnessInstallationParamsSchema,
  harnessInstallationTaskParamsSchema,
  type HarnessInstallationTask,
} from "@codexhost/shared-contracts";
import { handleHarnessInstallation, HarnessInstallationError } from "./harness-installation.js";

/** Host-owned operations outlive their short submission and status RPCs. */
export class HarnessInstallationTasks {
  readonly #tasks = new Map<string, { state: HarnessInstallationTask; finishedAt?: number }>();
  readonly #active = new Map<string, string>();

  #prune(): void {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [id, task] of this.#tasks) {
      if (task.finishedAt !== undefined && task.finishedAt < cutoff) this.#tasks.delete(id);
    }
  }

  start(params: unknown, adapters: ReadonlyMap<string, HarnessAdapter>): HarnessInstallationTask {
    const parsed = harnessInstallationParamsSchema.safeParse(params);
    if (!parsed.success)
      throw new HarnessInstallationError(-32602, "Invalid Harness installation request");
    this.#prune();
    const key = JSON.stringify([parsed.data.harnessId, parsed.data.action]);
    const activeId = this.#active.get(key);
    const active = activeId ? this.#tasks.get(activeId) : undefined;
    if (active) return active.state;
    const taskId = randomUUID();
    const task: { state: HarnessInstallationTask; finishedAt?: number } = {
      state: { taskId, status: "running" },
    };
    this.#tasks.set(taskId, task);
    this.#active.set(key, taskId);
    void handleHarnessInstallation(parsed.data, adapters)
      .then(
        (result) => {
          task.state = { taskId, status: "succeeded", result };
        },
        (error: unknown) => {
          task.state = {
            taskId,
            status: "failed",
            error:
              error instanceof HarnessInstallationError
                ? { code: error.code, message: error.message }
                : { code: -32077, message: "Harness version management failed" },
          };
        },
      )
      .finally(() => {
        task.finishedAt = Date.now();
        this.#active.delete(key);
      });
    return task.state;
  }

  status(params: unknown): HarnessInstallationTask {
    const parsed = harnessInstallationTaskParamsSchema.safeParse(params);
    if (!parsed.success)
      throw new HarnessInstallationError(-32602, "Invalid Harness installation task request");
    this.#prune();
    const task = this.#tasks.get(parsed.data.taskId);
    if (!task)
      throw new HarnessInstallationError(
        -32079,
        "Harness installation task is unavailable on this Host",
      );
    return task.state;
  }
}
