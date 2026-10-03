import { describe, expect, it, vi } from "vitest";

import { BrokeredHarnessAdapter } from "@codexhost/harness-broker";

import { warmup } from "../src/plugin.js";

describe("Claude Code plugin warmup", () => {
  it("does not inspect a brokered adapter, so Host startup starts no Aqua broker", async () => {
    const startBroker = vi.fn(async () => undefined);
    const adapter = new BrokeredHarnessAdapter({
      descriptorPath: "/nonexistent/broker.json",
      startBroker,
    });
    const inspect = vi.spyOn(adapter, "inspect");

    await warmup(adapter);

    expect(inspect).not.toHaveBeenCalled();
    expect(startBroker).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("still prefetches a native adapter", async () => {
    const inspect = vi.fn(async () => ({ status: "notInstalled" }) as never);

    await warmup({ inspect });

    expect(inspect).toHaveBeenCalledOnce();
  });
});
