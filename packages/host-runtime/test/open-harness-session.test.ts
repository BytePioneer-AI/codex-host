import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type { HarnessAdapter, OpenSessionInput } from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  nativeSessionRefSchema,
  nativeCheckpointRefSchema,
} from "@codexhost/shared-contracts";
import { openHarnessSession } from "../src/open-harness-session.js";
import { DELEGATION_THREAD_ID_ENV } from "../src/delegation-types.js";

const harnessId = harnessIdSchema.parse("fixture");
const nativeRef = nativeSessionRefSchema.parse({
  harnessId,
  nativeSessionId: "fixture-native",
  formatVersion: 1,
});
const checkpoint = nativeCheckpointRefSchema.parse({ ...nativeRef, checkpointId: "checkpoint" });
const createInput: OpenSessionInput = { kind: "create", cwd: "/fixture" };
const inputs: OpenSessionInput[] = [
  createInput,
  { kind: "resume", cwd: "/fixture", nativeRef },
  { kind: "fork", cwd: "/fixture", sourceRef: nativeRef, checkpoint },
  { kind: "rollbackLastTurn", cwd: "/fixture", sourceRef: nativeRef },
];
describe("Host-generated Session environments", () => {
  it.each(inputs)(
    "does not inject Thread identity into a native shared service ($kind)",
    async (input) => {
      const scope = vi.fn(async () => "native" as const);
      const adapter: HarnessAdapter = Object.assign(new FakeHarnessAdapter(harnessId), {
        sessionEnvironmentScope: scope,
      });
      const open = vi.spyOn(adapter, "open");
      try {
        await openHarnessSession(
          adapter,
          input,
          { RUNTIME_TOKEN: "not-for-shared-processes" },
          "thread-a",
        );
        expect(scope).toHaveBeenCalledExactlyOnceWith(input);
        expect(open).toHaveBeenCalledExactlyOnceWith(input);
      } finally {
        await adapter.close();
      }
    },
  );
  it("preserves legacy behavior and isolates identities for ordinary process-backed Sessions", async () => {
    const adapter = new FakeHarnessAdapter(harnessId),
      open = vi.spyOn(adapter, "open");
    try {
      await openHarnessSession(
        adapter,
        createInput,
        { PATH: "/bin", [DELEGATION_THREAD_ID_ENV]: "parent" },
        "child",
      );
      expect(open).toHaveBeenCalledWith({
        ...inputs[0],
        environment: { PATH: "/bin", [DELEGATION_THREAD_ID_ENV]: "child" },
      });
    } finally {
      await adapter.close();
    }
  });
  it("never drops explicit overrides and fails closed when scope cannot be determined", async () => {
    const scope = vi.fn(async (): Promise<"native"> => {
      throw new Error("private diagnostic");
    });
    const adapter: HarnessAdapter = Object.assign(new FakeHarnessAdapter(harnessId), {
      sessionEnvironmentScope: scope,
    });
    const open = vi.spyOn(adapter, "open");
    try {
      const input = { ...createInput, environment: { CUSTOM: "caller value" } };
      await openHarnessSession(adapter, input, { CUSTOM: "base" }, "thread");
      expect(scope).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledExactlyOnceWith(input);
      open.mockClear();
      const result = await openHarnessSession(adapter, createInput, {}, "thread");
      expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(JSON.stringify(result)).not.toContain("private diagnostic");
      expect(open).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });
});
