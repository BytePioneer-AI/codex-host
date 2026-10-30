import { describe, expect, it, vi } from "vitest";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";

import { QoderAdapter } from "../src/qoder-adapter.js";
import {
  isQoderPlanModeId,
  mapToQoderPermissionModeExcludingPlan,
} from "../src/qoder-permission-modes.js";
import type {
  QoderOptions,
  QoderQuery,
  QoderQueryFactory,
  SDKMessage,
} from "../src/qoder-sdk-types.js";

class RecordingQuery implements QoderQuery {
  readonly interrupt = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  });
  readonly setPermissionMode = vi.fn(async () => undefined);
  readonly setPlanMode = vi.fn(async () => undefined);
  readonly options: QoderOptions | undefined;

  #closed = false;
  #messages: SDKMessage[] = [];
  #waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];

  constructor(options?: QoderOptions) {
    this.options = options;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const message = this.#messages.shift();
        if (message) return Promise.resolve({ done: false, value: message });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

describe("Qoder SDK 1.0.58 compatibility", () => {
  it("maps plan to planMode instead of permissionMode", () => {
    const plan = harnessPermissionModeIdSchema.parse("plan");
    expect(isQoderPlanModeId(plan)).toBe(true);
    expect(mapToQoderPermissionModeExcludingPlan(plan)).toBeUndefined();
    expect(
      mapToQoderPermissionModeExcludingPlan(harnessPermissionModeIdSchema.parse("default")),
    ).toBe("default");
  });

  it("opens a plan session with planMode and uses setPlanMode on switch", async () => {
    const queries: RecordingQuery[] = [];
    const queryFactory: QoderQueryFactory = (input) => {
      const query = new RecordingQuery(input.options);
      queries.push(query);
      return query;
    };
    const adapter = new QoderAdapter({
      queryFactory,
      resolveExecutable: () => "/tmp/fake-qodercli",
    });

    const opened = await adapter.open({
      kind: "create",
      cwd: "/tmp",
      permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
      environment: { CODEXHOST_THREAD_ID: "thread-a" },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    expect(queries[0]?.options?.planMode).toBe(true);
    expect(queries[0]?.options?.permissionMode).toBeUndefined();

    const result = await opened.value.execute({
      type: "permissionMode.select",
      permissionModeId: harnessPermissionModeIdSchema.parse("default"),
    });
    expect(result.ok).toBe(true);
    expect(queries[0]?.setPlanMode).toHaveBeenCalledWith(false);
    expect(queries[0]?.setPermissionMode).toHaveBeenCalledWith("default");

    await adapter.close();
  });
});
