import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { detectOpenCode } from "../src/version.js";
import { OpenCodeAdapter } from "../src/versioned-adapter.js";
import { OpenCodeAdapter as V1Adapter } from "../src/opencode-adapter.js";
import { V2Adapter } from "../src/v2/adapter.js";

vi.mock("../src/version.js", () => ({ detectOpenCode: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(detectOpenCode).mockReset();
});

describe("OpenCode plugin version routing", () => {
  it("selects the installed protocol on every inspection and closes transient adapters", async () => {
    vi.mocked(detectOpenCode)
      .mockResolvedValueOnce({ major: 1, executable: "/test/v1" })
      .mockResolvedValueOnce({ major: 2, executable: "/test/v2" });
    const result = {
      status: "notInstalled" as const,
      error: { code: "notInstalled" as const, message: "test", retryable: false },
    };
    const legacy = vi.spyOn(V1Adapter.prototype, "inspect").mockResolvedValue(result);
    const modern = vi.spyOn(V2Adapter.prototype, "inspect").mockResolvedValue(result);
    const close1 = vi.spyOn(V1Adapter.prototype, "close").mockResolvedValue();
    const close2 = vi.spyOn(V2Adapter.prototype, "close").mockResolvedValue();
    const adapter = new OpenCodeAdapter();
    await adapter.inspect();
    await adapter.inspect({ refresh: true });
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(modern).toHaveBeenCalledTimes(1);
    expect(close1).toHaveBeenCalledTimes(1);
    expect(close2).toHaveBeenCalledTimes(1);
    await adapter.close();
  });

  it.each([1, 2] as const)(
    "does not migrate a saved Session when CLI v%s is selected",
    async (major) => {
      vi.mocked(detectOpenCode).mockResolvedValue({ major, executable: "/test/opencode" });
      const nativeRef = nativeSessionRefSchema.parse({
        harnessId: "opencode",
        nativeSessionId: "saved",
        formatVersion: 1,
        locator: {
          directory: "/workspace",
          executionPolicy: "default",
          ...(major === 1 ? { protocol: 2 } : {}),
        },
      });
      const legacy = vi.spyOn(V1Adapter.prototype, "open");
      const modern = vi.spyOn(V2Adapter.prototype, "open");
      const adapter = new OpenCodeAdapter();
      const result = await adapter.open({
        kind: "resume",
        nativeRef,
        cwd: "/workspace",
        environment: { CODEXHOST_OPENCODE_COMMAND: "/test/opencode" },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("does not migrate histories") },
      });
      expect(legacy).not.toHaveBeenCalled();
      expect(modern).not.toHaveBeenCalled();
      expect(detectOpenCode).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: expect.objectContaining({ CODEXHOST_OPENCODE_COMMAND: "/test/opencode" }),
        }),
      );
      await adapter.close();
    },
  );
});
