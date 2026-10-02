import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesAdapter } from "../src/hermes-adapter.js";
import { HermesImportTransport } from "../src/import-transport.js";
import { HermesGatewayTransport } from "../src/gateway-transport.js";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import * as gatewayOpen from "../src/gateway-open.js";
import { HermesGatewayHistory } from "../src/gateway-history.js";
import type { HermesSession } from "../src/hermes-session.js";

afterEach(() => vi.restoreAllMocks());
describe("Hermes Gateway-only chat routing", () => {
  it.each([undefined, 7, 999])("resumes saved gateway contract metadata %s", async (contract) => {
    const cwd = process.cwd();
    const transport = new HermesGatewayTransport("unused", cwd, {});
    vi.spyOn(transport, "prepareSession").mockResolvedValue();
    vi.spyOn(transport, "start").mockResolvedValue();
    vi.spyOn(transport, "close").mockResolvedValue();
    const request = vi.spyOn(transport, "request").mockImplementation(async (method) => {
      if (method === "session.resume")
        return {
          session_id: "runtime",
          info: { stored_session_id: "saved", cwd, model: "test", provider: "custom" },
        };
      return { value: "low" };
    });
    vi.spyOn(HermesGatewayHistory.prototype, "resolvePhysicalSessionId").mockResolvedValue("saved");
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "hermes",
      nativeSessionId: "saved",
      formatVersion: 1,
      locator: { transport: "gateway", ...(contract === undefined ? {} : { contract }) },
    });
    const session = await gatewayOpen.openGatewaySession(
      { kind: "resume", nativeRef, cwd },
      transport,
      () => {},
    );
    try {
      expect(request).toHaveBeenCalledWith("session.resume", {
        session_id: "saved",
        eager_build: true,
        omit_messages: true,
      });
      expect(session.initialState.nativeRef?.nativeSessionId).toBe("saved");
      expect(session.initialState.nativeRef?.locator).not.toHaveProperty("contract");
    } finally {
      await session.close();
    }
  });
  it("does not start a Session when the Adapter closes during gateway discovery", async () => {
    let finishProbe: (python: string | null) => void = () => undefined;
    const pendingProbe = new Promise<string | null>((resolve) => {
      finishProbe = resolve;
    });
    const probe = vi.spyOn(HermesGatewayTransport, "probe").mockReturnValue(pendingProbe);
    const prepare = vi
      .spyOn(HermesGatewayTransport.prototype, "prepareSession")
      .mockResolvedValue();
    const start = vi
      .spyOn(HermesGatewayTransport.prototype, "start")
      .mockRejectedValue(new Error("Unexpected gateway startup"));
    const imports = vi.spyOn(HermesImportTransport.prototype, "probeConnection");
    const adapter = new HermesAdapter({ command: process.execPath });
    const opening = adapter.open({ kind: "create", cwd: process.cwd() });
    expect(probe).toHaveBeenCalledOnce();
    await adapter.close();
    finishProbe("/supported/python");
    expect(await opening).toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(prepare).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(imports).not.toHaveBeenCalled();
  });
  it.each(["fork", "rollbackLastTurn"] as const)(
    "rejects non-Gateway references for %s rather than relabelling them",
    async (kind) => {
      const probe = vi.spyOn(HermesGatewayTransport, "probe");
      const imports = vi.spyOn(HermesImportTransport.prototype, "probeConnection");
      const adapter = new HermesAdapter({ command: process.execPath });
      const ref = nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "old",
        formatVersion: 1,
      });
      try {
        expect(
          await adapter.open(
            kind === "fork"
              ? {
                  kind,
                  sourceRef: ref,
                  cwd: process.cwd(),
                  checkpoint: {
                    harnessId: ref.harnessId,
                    nativeSessionId: ref.nativeSessionId,
                    checkpointId: "1",
                    formatVersion: 1,
                  },
                }
              : { kind, sourceRef: ref, cwd: process.cwd() },
          ),
        ).toMatchObject({ ok: false, error: { code: "unsupported" } });
        expect(probe).not.toHaveBeenCalled();
        expect(imports).not.toHaveBeenCalled();
      } finally {
        await adapter.close();
      }
    },
  );
  it("resumes an unmarked import identity through the actual Gateway without mutating the input reference", async () => {
    vi.spyOn(HermesGatewayTransport, "probe").mockResolvedValue("/supported/python");
    const imports = vi.spyOn(HermesImportTransport.prototype, "probeConnection");
    const ref = nativeSessionRefSchema.parse({
      harnessId: "hermes",
      nativeSessionId: "imported",
      formatVersion: 1,
    });
    const open = vi
      .spyOn(gatewayOpen, "openGatewaySession")
      .mockResolvedValue({
        initialState: {},
        close: vi.fn(async () => undefined),
      } as unknown as HermesSession);
    const adapter = new HermesAdapter({ command: process.execPath });
    try {
      expect(
        await adapter.open({ kind: "resume", nativeRef: ref, cwd: process.cwd() }),
      ).toMatchObject({ ok: true });
      expect(open.mock.calls[0]?.[0]).toMatchObject({ kind: "resume", nativeRef: ref });
      expect(ref.locator).toBeUndefined();
      expect(imports).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });
  it.each(["create", "resume"] as const)(
    "never starts ACP when Gateway is unavailable for %s",
    async (kind) => {
      vi.spyOn(HermesGatewayTransport, "probe").mockResolvedValue(null);
      const imports = vi.spyOn(HermesImportTransport.prototype, "probeConnection");
      const adapter = new HermesAdapter({ command: process.execPath });
      const ref = nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "gateway",
        formatVersion: 1,
        locator: { transport: "gateway" },
      });
      try {
        expect(
          await adapter.open(
            kind === "create"
              ? { kind, cwd: process.cwd() }
              : { kind, nativeRef: ref, cwd: process.cwd() },
          ),
        ).toMatchObject({ ok: false, error: { code: "unavailable" } });
        expect(await adapter.inspect()).toMatchObject({
          status: "error",
          error: { code: "HERMES_UNAVAILABLE" },
        });
        expect(imports).not.toHaveBeenCalled();
      } finally {
        await adapter.close();
      }
    },
  );
  it("creates through Gateway with the complete Thread environment and no ACP warm process", async () => {
    vi.spyOn(HermesGatewayTransport, "probe").mockResolvedValue("/supported/python");
    const imports = vi.spyOn(HermesImportTransport.prototype, "probeConnection");
    const session = {
      initialState: {},
      close: vi.fn(async () => undefined),
    } as unknown as HermesSession;
    const open = vi.spyOn(gatewayOpen, "openGatewaySession").mockResolvedValue(session);
    const adapter = new HermesAdapter({
      command: process.execPath,
      environment: { BASE: "installation" },
    });
    const input = {
      kind: "create" as const,
      cwd: process.cwd(),
      environment: { CODEXHOST_THREAD_ID: "thread-id", THREAD_CONFIG: "native" },
    };
    try {
      expect(await adapter.open(input)).toEqual({ ok: true, value: session });
      expect(open).toHaveBeenCalledOnce();
      const transport = open.mock.calls[0]?.[1];
      expect(transport?.environment).toEqual({
        BASE: "installation",
        CODEXHOST_THREAD_ID: "thread-id",
        THREAD_CONFIG: "native",
      });
      expect(imports).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });
  it("keeps a single owner during concurrent Gateway resume", async () => {
    vi.spyOn(HermesGatewayTransport, "probe").mockResolvedValue("/supported/python");
    let finish!: (session: HermesSession) => void;
    const open = vi.spyOn(gatewayOpen, "openGatewaySession").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const adapter = new HermesAdapter({ command: process.execPath });
    const ref = nativeSessionRefSchema.parse({
      harnessId: "hermes",
      nativeSessionId: "saved",
      formatVersion: 1,
      locator: { transport: "gateway" },
    });
    const input = { kind: "resume" as const, nativeRef: ref, cwd: process.cwd() };
    try {
      const pending = adapter.open(input);
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      expect(await adapter.open(input)).toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      finish({
        initialState: { nativeRef: ref },
        close: vi.fn(async () => undefined),
      } as unknown as HermesSession);
      expect(await pending).toMatchObject({ ok: true });
      expect(await adapter.open(input)).toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
    } finally {
      await adapter.close();
    }
  });
});
