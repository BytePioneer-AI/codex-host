import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesAdapter } from "../src/hermes-adapter.js";
import { HermesGatewayTransport } from "../src/gateway-transport.js";
import * as reader from "../src/gateway-session-list.js";
import {
  listHermesSessionCandidates,
  resolveHermesSessionCandidate,
} from "../src/hermes-import.js";

const options = { runtime: "/native/python", cwd: process.cwd(), environment: {} };
const row = { id: "native", title: "Native title", cwd: "/project", last_active: 1700000000.125 };
afterEach(() => vi.restoreAllMocks());

describe("Hermes native session discovery", () => {
  it("projects native timestamps, deduplicates identities, and leaves activity unknown", async () => {
    vi.spyOn(reader, "readHermesSessions").mockResolvedValue([
      row,
      row,
      { ...row, id: "untitled", title: " " },
      null,
      { ...row, id: " " },
      { ...row, cwd: " " },
      { ...row, last_active: "1700000000" },
      { ...row, last_active: -0.001 },
      { ...row, last_active: Infinity },
      { ...row, last_active: 9e15 },
    ]);
    expect(await listHermesSessionCandidates(options)).toEqual([
      {
        nativeSessionId: "native",
        title: "Native title",
        cwd: "/project",
        updatedAt: 1700000000125,
        running: null,
      },
      {
        nativeSessionId: "untitled",
        title: null,
        cwd: "/project",
        updatedAt: 1700000000125,
        running: null,
      },
    ]);
  });

  it("rechecks a selected ID and never manufactures a Gateway locator", async () => {
    const read = vi.spyOn(reader, "readHermesSessions").mockResolvedValue([row]);
    expect(await listHermesSessionCandidates(options)).toHaveLength(1);
    read.mockResolvedValue([{ ...row, title: "New title", cwd: "/moved" }]);
    expect(await resolveHermesSessionCandidate({ ...options, nativeSessionId: "native" })).toEqual({
      candidate: {
        nativeSessionId: "native",
        title: "New title",
        cwd: "/moved",
        updatedAt: 1700000000125,
        running: null,
      },
      nativeRef: { harnessId: "hermes", nativeSessionId: "native", formatVersion: 1 },
    });
    expect(read).toHaveBeenLastCalledWith({ ...options, nativeSessionId: "native" });
    read.mockResolvedValue([{ ...row, id: "native-other" }]);
    expect(
      await resolveHermesSessionCandidate({ ...options, nativeSessionId: "native" }),
    ).toBeNull();
  });

  it("uses the selected runtime and installation environment without a Thread identity", async () => {
    vi.spyOn(HermesGatewayTransport, "probe").mockResolvedValue({ launcher: "/selected/hermes" });
    const read = vi.spyOn(reader, "readHermesSessions").mockResolvedValue([row]);
    const adapter = new HermesAdapter({
      command: process.execPath,
      environment: { HERMES_HOME: "/profile", CODEXHOST_THREAD_ID: "not-a-chat" },
    });
    try {
      expect(await adapter.sessionImport.listCandidates()).toMatchObject({
        ok: true,
        value: [{ nativeSessionId: "native" }],
      });
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({
          runtime: { launcher: "/selected/hermes" },
          environment: { HERMES_HOME: "/profile" },
          signal: expect.any(AbortSignal),
        }),
      );
      read.mockResolvedValue([]);
      expect(await adapter.sessionImport.resolveCandidate("native")).toMatchObject({
        ok: false,
        error: { code: "sessionNotFound" },
      });
    } finally {
      await adapter.close();
    }
  });

  it("does not treat runtime or native storage failures as an empty listing", async () => {
    vi.spyOn(HermesGatewayTransport, "probe").mockResolvedValue(null);
    const read = vi
      .spyOn(reader, "readHermesSessions")
      .mockRejectedValue(new Error("native store unavailable"));
    const adapter = new HermesAdapter({ command: process.execPath });
    try {
      expect(await adapter.sessionImport.listCandidates()).toMatchObject({
        ok: false,
        error: { code: "unavailable" },
      });
      expect(read).not.toHaveBeenCalled();
      vi.spyOn(HermesGatewayTransport, "probe").mockResolvedValue(options.runtime);
      // A fresh Adapter has no cached negative probe.
      const available = new HermesAdapter({ command: process.execPath });
      try {
        expect(await available.sessionImport.listCandidates()).toMatchObject({
          ok: false,
          error: { code: "nativeFailure" },
        });
      } finally {
        await available.close();
      }
    } finally {
      await adapter.close();
    }
  });

  it("reports a missing executable as notInstalled", async () => {
    const adapter = new HermesAdapter({ command: "/absent/hermes-test-binary" });
    try {
      expect(await adapter.sessionImport.listCandidates()).toMatchObject({
        ok: false,
        error: { code: "notInstalled" },
      });
    } finally {
      await adapter.close();
    }
  });

  it("never starts a metadata reader if closed while resolving the runtime", async () => {
    let finish!: (runtime: string) => void;
    vi.spyOn(HermesGatewayTransport, "probe").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const read = vi.spyOn(reader, "readHermesSessions");
    const adapter = new HermesAdapter({ command: process.execPath });
    const pending = adapter.sessionImport.listCandidates();
    await adapter.close();
    finish(options.runtime);
    expect(await pending).toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(read).not.toHaveBeenCalled();
    expect(await adapter.sessionImport.listCandidates()).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
  });

  it("aborts an in-flight reader and refuses a late successful response", async () => {
    vi.spyOn(HermesGatewayTransport, "probe").mockResolvedValue(options.runtime);
    let finish!: (rows: unknown[]) => void;
    let signal: AbortSignal | undefined;
    const read = vi.spyOn(reader, "readHermesSessions").mockImplementation((input) => {
      signal = input.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const adapter = new HermesAdapter({ command: process.execPath });
    const pending = adapter.sessionImport.listCandidates();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const closed = adapter.close();
    expect(signal?.aborted).toBe(true);
    finish([row]);
    await closed;
    expect(await pending).toMatchObject({ ok: false, error: { code: "invalidState" } });
  });
});
