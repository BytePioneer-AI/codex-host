import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessResult, HarnessSession } from "@codexhost/harness-adapter";
import {
  harnessCommandDescriptorSchema,
  type HarnessCommandCatalog,
} from "@codexhost/shared-contracts";

import {
  ExternalCommandError,
  inspectLiveCommandCatalog,
  resolveExternalCommand,
} from "../src/external-command-routing.js";

afterEach(() => vi.useRealTimers());

describe("bounded live command inspection", () => {
  it.each(["success", "failure", "throw"])("clears its timer after %s", async (outcome) => {
    vi.useFakeTimers();
    const commands: NonNullable<HarnessSession["commands"]> = {
      list: async () => {
        if (outcome === "throw") throw new Error("offline");
        return outcome === "success"
          ? { ok: true, value: { commands: [] } }
          : { ok: false, error: { code: "unavailable", message: "offline", retryable: true } };
      },
      execute: async ({ turnId }) => ({ ok: true, value: { turnId } }),
    };
    await expect(inspectLiveCommandCatalog(commands)).resolves.toEqual(
      outcome === "success" ? { commands: [] } : null,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a late rejection after falling back at the inspection deadline", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<HarnessResult<HarnessCommandCatalog>>();
    const commands: NonNullable<HarnessSession["commands"]> = {
      list: () => pending.promise,
      execute: async ({ turnId }) => ({ ok: true, value: { turnId } }),
    };
    const result = inspectLiveCommandCatalog(commands, 10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBeNull();
    pending.reject(new Error("late native failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("command resolution before the live catalog loads", () => {
  const builtInsOnly: NonNullable<HarnessSession["commands"]> = {
    list: async () => ({
      ok: true,
      value: {
        commands: [
          harnessCommandDescriptorSchema.parse({
            id: "x.compact",
            invocation: "/compact",
            label: "Compact",
            argumentMode: "none",
          }),
        ],
      },
    }),
    execute: async ({ turnId }) => ({ ok: true, value: { turnId } }),
  };

  it("passes an unknown command through as a prompt while the catalog is pending", async () => {
    await expect(
      resolveExternalCommand(builtInsOnly, "/teambition 你好", { liveCatalogPending: () => true }),
    ).resolves.toBeNull();
  });

  it("still rejects excluded commands and unknown commands once the catalog is live", async () => {
    await expect(
      resolveExternalCommand(builtInsOnly, "/clear", { liveCatalogPending: () => true }),
    ).rejects.toBeInstanceOf(ExternalCommandError);
    await expect(
      resolveExternalCommand(builtInsOnly, "/teambition", { liveCatalogPending: () => false }),
    ).rejects.toMatchObject({ code: -32078 });
    await expect(resolveExternalCommand(builtInsOnly, "/teambition")).rejects.toMatchObject({
      code: -32078,
    });
  });

  it("keeps resolving catalog commands", async () => {
    await expect(
      resolveExternalCommand(builtInsOnly, "/compact", { liveCatalogPending: () => true }),
    ).resolves.toEqual({
      descriptor: {
        id: "x.compact",
        invocation: "/compact",
        label: "Compact",
        argumentMode: "none",
      },
    });
  });

  it("refreshes a live catalog once before rejecting a newly installed command", async () => {
    const descriptor = harnessCommandDescriptorSchema.parse({
      id: "omp.slash.duo",
      invocation: "/duo",
      label: "Duo",
      argumentMode: "text",
    });
    const refresh = vi.fn(async () => ({ ok: true as const, value: { commands: [descriptor] } }));
    const commands = { ...builtInsOnly, refresh };
    await expect(
      resolveExternalCommand(commands, "/duo 分工", { liveCatalogPending: () => false }),
    ).resolves.toEqual({ descriptor, arguments: { text: "分工" } });
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(resolveExternalCommand(commands, "/clear")).rejects.toMatchObject({
      code: -32078,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not retry native delivery or refresh a catalog that has not loaded", async () => {
    const refresh = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: "sessionBusy" as const,
        message: "still reviewing",
        retryable: true,
      },
    }));
    const commands = { ...builtInsOnly, refresh };
    await expect(
      resolveExternalCommand(commands, "/duo", { liveCatalogPending: () => true }),
    ).resolves.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    await expect(resolveExternalCommand(commands, "/duo")).rejects.toMatchObject({
      code: -32072,
      message: "still reviewing",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
