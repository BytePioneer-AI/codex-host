import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";
import { HostPluginRuntime } from "../src/host-plugin-runtime.js";

describe("Host plugin lifecycle", () => {
  it("owns effects per runtime and disposes once", async () => {
    const first = new HostPluginRuntime();
    const second = new HostPluginRuntime();
    const cleanup = vi.fn();
    const plugin = {
      name: "diagnostic-fixture",
      apply(ctx: Context) {
        ctx.effect(() => cleanup);
      },
    };
    await first.mount(plugin);
    await second.mount(plugin);
    await Promise.all([first.close(), first.close()]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(first.mount(plugin)).rejects.toThrow("closed");
    await second.close();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("cleans a failed mount without preventing independent plugins", async () => {
    const runtime = new HostPluginRuntime();
    const cleanup = vi.fn();
    await expect(
      runtime.mount({
        name: "broken",
        apply(ctx) {
          ctx.effect(() => cleanup);
          throw new Error("fixture failure");
        },
      }),
    ).rejects.toThrow("fixture failure");
    expect(cleanup).toHaveBeenCalledTimes(1);
    const other = vi.fn();
    await runtime.mount({
      name: "healthy",
      apply(ctx) {
        ctx.effect(() => other);
      },
    });
    await runtime.close();
    expect(other).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
