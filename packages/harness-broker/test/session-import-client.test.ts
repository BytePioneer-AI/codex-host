import { describe, expect, it, vi } from "vitest";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { BrokeredHarnessAdapter } from "../src/client.js";
import { createBrokerSessionImportCapability } from "../src/session-import-client.js";

const candidate = {
  nativeSessionId: "native-session",
  title: "Session",
  cwd: "/project",
  updatedAt: 1_700_000_000_000,
  running: null,
};
const harnessId = harnessIdSchema.parse("codebuddy");
const options = {
  harnessId,
  isClosed: () => false,
  error: () => ({ code: "unavailable" as const, message: "Broker unavailable", retryable: true }),
};

describe("Broker Session import capability", () => {
  it("is opt-in for plugins with native import support", async () => {
    const adapter = new BrokeredHarnessAdapter({ startBroker: false });
    expect(adapter.sessionImport).toBeUndefined();
    await adapter.close();
  });

  it("coalesces list calls and obtains a new snapshot on refresh", async () => {
    const request = vi.fn(async () => ({
      ok: true as const,
      value: { candidates: [candidate], total: 1 },
    }));
    const capability = createBrokerSessionImportCapability({ ...options, request });
    await Promise.all([capability.listCandidates(), capability.listCandidates()]);
    expect(request).toHaveBeenCalledOnce();
    await capability.listCandidates();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["changed-total", "duplicate", "empty-page"])(
    "rejects %s rather than returning a partial or mixed list",
    async (reason) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: { candidates: [candidate], total: 2 } })
        .mockResolvedValueOnce({
          ok: true,
          value:
            reason === "changed-total"
              ? { candidates: [{ ...candidate, nativeSessionId: "second" }], total: 3 }
              : reason === "duplicate"
                ? { candidates: [candidate], total: 2 }
                : { candidates: [], total: 2 },
        });
      const capability = createBrokerSessionImportCapability({ ...options, request });
      await expect(capability.listCandidates()).resolves.toMatchObject({
        ok: false,
        error: { code: "protocolError" },
      });
    },
  );

  it.each(["foreign-harness", "foreign-session"])("rejects a %s source", async (reason) => {
    const request = vi.fn(async () => ({
      ok: true as const,
      value: {
        candidate,
        nativeRef: {
          harnessId: reason === "foreign-harness" ? "claude-code" : harnessId,
          nativeSessionId: reason === "foreign-session" ? "other" : candidate.nativeSessionId,
          formatVersion: 1,
        },
      },
    }));
    const capability = createBrokerSessionImportCapability({ ...options, request });
    await expect(capability.resolveCandidate?.(candidate.nativeSessionId)).resolves.toMatchObject({
      ok: false,
      error: { code: "protocolError" },
    });
  });

  it("rejects results arriving after close and never starts another read", async () => {
    let closed = false;
    const request = vi.fn(async () => {
      closed = true;
      return { ok: true as const, value: { candidates: [candidate], total: 1 } };
    });
    const capability = createBrokerSessionImportCapability({
      ...options,
      request,
      isClosed: () => closed,
    });
    await expect(capability.listCandidates()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await expect(capability.listCandidates()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await expect(capability.resolveCandidate?.(candidate.nativeSessionId)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(request).toHaveBeenCalledOnce();
  });
});
