import {
  HARNESS_INSTALLATION_START_METHOD,
  HARNESS_INSTALLATION_STATUS_METHOD,
  harnessInstallationParamsSchema,
  harnessInstallationTaskSchema,
  type HarnessInstallationParams,
  type HarnessInstallationState,
} from "@codexhost/shared-contracts";
import type { RendererRequestOptions } from "./renderer-request-sender.js";

/** Native request capacity is held only while submitting or reading a task. */
export async function runRendererInstallation(
  send: (method: string, params: unknown, options?: RendererRequestOptions) => Promise<unknown>,
  input: HarnessInstallationParams,
): Promise<HarnessInstallationState> {
  const params = harnessInstallationParamsSchema.parse(input);
  const options: RendererRequestOptions = { priority: "background", timeoutMs: 15_000 };
  let task = harnessInstallationTaskSchema.parse(
    await send(HARNESS_INSTALLATION_START_METHOD, params, options),
  );
  const taskId = task.taskId;
  while (task.status === "running") {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 500));
    task = harnessInstallationTaskSchema.parse(
      await send(HARNESS_INSTALLATION_STATUS_METHOD, { taskId }, options),
    );
    if (task.taskId !== taskId) throw new Error("Harness installation task identity changed");
  }
  if (task.status === "failed")
    throw Object.assign(new Error(task.error.message), { code: task.error.code });
  return task.result;
}
