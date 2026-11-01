import { describe, expect, it, vi } from "vitest";
import { QoderAdapter } from "../src/qoder-adapter.js";
import type { QoderSdkDaemon } from "../src/qoder-daemon-pool.js";
import { decodeQoderModelRef } from "../src/qoder-models.js";
import type { QoderModelInfo, QoderQuery, QoderQueryFactory } from "../src/qoder-sdk-types.js";

function model(value: string): QoderModelInfo {
  return { value, displayName: value, description: "", isDefault: true };
}

function probe(getAvailableModels: NonNullable<QoderQuery["getAvailableModels"]>) {
  let initialized = false;
  return {
    initializationResult: vi.fn(async () => {
      initialized = true;
    }),
    getAvailableModels: vi.fn<NonNullable<QoderQuery["getAvailableModels"]>>(async (options) =>
      initialized ? getAvailableModels(options) : [],
    ),
    close: vi.fn(async () => undefined),
  };
}

describe.each(["global", "cn"] as const)("Qoder %s model inspection", (variant) => {
  it("loads cold daemon models live and caches the catalog by cwd until refresh", async () => {
    const probes: ReturnType<typeof probe>[] = [];
    const stops: ReturnType<typeof vi.fn>[] = [];
    const queryFactory = vi.fn<QoderQueryFactory>(() => {
      const value = `model-${probes.length + 1}`;
      const query = probe(async (options) =>
        options?.fetchStrategy === "live" ? [model(value)] : [],
      );
      probes.push(query);
      return query as unknown as QoderQuery;
    });
    const adapter = new QoderAdapter({
      variant,
      resolveExecutable: () => "qodercli",
      queryFactory,
      startDaemon: async () => {
        const stop = vi.fn(async () => undefined);
        stops.push(stop);
        return { stop } as unknown as QoderSdkDaemon;
      },
    });
    const cwd = "/project";
    try {
      const first = await adapter.inspect({ cwd });
      expect(first.status).toBe("ready");
      if (first.status !== "ready") throw new Error("Model inspection failed");
      expect(first.catalog.models.map(({ ref }) => decodeQoderModelRef(ref))).toEqual(["model-1"]);
      expect(first.catalog.defaultModel).toEqual(first.catalog.models[0]?.ref);
      expect(await adapter.inspect({ cwd })).toBe(first);
      expect(queryFactory).toHaveBeenCalledTimes(1);

      const refreshed = await adapter.inspect({ cwd, refresh: true });
      expect(refreshed.status).toBe("ready");
      if (refreshed.status !== "ready") throw new Error("Model refresh failed");
      expect(refreshed.catalog.models.map(({ ref }) => decodeQoderModelRef(ref))).toEqual([
        "model-2",
      ]);
      expect(await adapter.inspect({ cwd })).toBe(refreshed);

      const other = await adapter.inspect({ cwd: "/other" });
      expect(other.status).toBe("ready");
      if (other.status !== "ready") throw new Error("Other directory inspection failed");
      expect(other.catalog.models.map(({ ref }) => decodeQoderModelRef(ref))).toEqual(["model-3"]);
      expect(await adapter.inspect({ cwd })).toBe(refreshed);
      expect(queryFactory).toHaveBeenCalledTimes(3);
      expect(stops).toHaveLength(3);
      for (const query of probes) {
        expect(query.initializationResult).toHaveBeenCalledOnce();
        expect(query.getAvailableModels).toHaveBeenCalledExactlyOnceWith({ fetchStrategy: "live" });
        expect(query.close).toHaveBeenCalledOnce();
      }
      for (const stop of stops) expect(stop).toHaveBeenCalledOnce();
    } finally {
      await adapter.close();
    }
  });

  it("does not cache an initialization failure or query models before initialization", async () => {
    const failed = probe(async () => [model("uninitialized")]);
    failed.initializationResult.mockRejectedValue(new Error("Initialization failed"));
    const recovered = probe(async () => [model("initialized")]);
    const queryFactory = vi
      .fn<QoderQueryFactory>()
      .mockReturnValueOnce(failed as unknown as QoderQuery)
      .mockReturnValueOnce(recovered as unknown as QoderQuery);
    const adapter = new QoderAdapter({
      variant,
      resolveExecutable: () => "qodercli",
      queryFactory,
    });
    try {
      expect(await adapter.inspect()).toMatchObject({
        status: "unavailable",
        error: { message: "Initialization failed" },
      });
      expect(failed.getAvailableModels).not.toHaveBeenCalled();
      expect(failed.close).toHaveBeenCalledOnce();
      expect(await adapter.inspect()).toMatchObject({
        status: "ready",
        catalog: { models: [{ label: "initialized" }] },
      });
      expect(queryFactory).toHaveBeenCalledTimes(2);
      expect(recovered.initializationResult).toHaveBeenCalledOnce();
      expect(recovered.close).toHaveBeenCalledOnce();
    } finally {
      await adapter.close();
    }
  });

  it("does not cache a failed live query and closes each probe", async () => {
    const failed = probe(async () => {
      throw new Error("Model query failed");
    });
    const recovered = probe(async (options) =>
      options?.fetchStrategy === "live" ? [model("recovered")] : [],
    );
    const queryFactory = vi
      .fn<QoderQueryFactory>()
      .mockReturnValueOnce(failed as unknown as QoderQuery)
      .mockReturnValueOnce(recovered as unknown as QoderQuery);
    const adapter = new QoderAdapter({
      variant,
      resolveExecutable: () => "qodercli",
      queryFactory,
    });
    try {
      expect(await adapter.inspect()).toMatchObject({
        status: "unavailable",
        error: { message: "Model query failed" },
      });
      const result = await adapter.inspect();
      expect(result).toMatchObject({
        status: "ready",
        catalog: { models: [{ label: "recovered" }] },
      });
      expect(await adapter.inspect()).toBe(result);
      expect(queryFactory).toHaveBeenCalledTimes(2);
      for (const query of [failed, recovered]) {
        expect(query.initializationResult).toHaveBeenCalledOnce();
        expect(query.getAvailableModels).toHaveBeenCalledExactlyOnceWith({ fetchStrategy: "live" });
        expect(query.close).toHaveBeenCalledOnce();
      }
    } finally {
      await adapter.close();
    }
  });
});
