import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesAdapter } from "../src/hermes-adapter.js";
import { HermesAcpTransport } from "../src/acp-transport.js";
import { HermesGatewayTransport } from "../src/gateway-transport.js";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { openGatewaySession } from "../src/gateway-open.js";
import { HermesGatewayHistory } from "../src/gateway-history.js";

afterEach(() => vi.restoreAllMocks());
describe("Hermes persisted transport ownership", () => {
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
    const session = await openGatewaySession(
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
    const acp = vi.spyOn(HermesAcpTransport.prototype, "open");
    const adapter = new HermesAdapter({ command: process.execPath });
    const opening = adapter.open({ kind: "create", cwd: process.cwd() });
    expect(probe).toHaveBeenCalledOnce();
    await adapter.close();
    finishProbe("/supported/python");
    expect(await opening).toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(prepare).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(acp).not.toHaveBeenCalled();
  });
  it("keeps old Native Refs exclusively on ACP even when gateway is available", async () => {
    const probe = vi.spyOn(HermesGatewayTransport, "probe").mockResolvedValue("/supported/python");
    vi.spyOn(HermesAcpTransport.prototype, "open").mockResolvedValue({
      initialize: { protocolVersion: 1 },
      session: { sessionId: "old", models: null, modes: null },
      sessionId: "old",
      replay: [],
    });
    vi.spyOn(HermesAcpTransport.prototype, "inspect").mockResolvedValue({ protocolVersion: 1 });
    vi.spyOn(HermesAcpTransport.prototype, "close").mockResolvedValue();
    const adapter = new HermesAdapter({ command: process.execPath });
    const ref = nativeSessionRefSchema.parse({
      harnessId: "hermes",
      nativeSessionId: "old",
      formatVersion: 1,
    });
    const opened = await adapter.open({ kind: "resume", nativeRef: ref, cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    const duplicate = await adapter.open({
      kind: "resume",
      nativeRef: { ...ref, locator: { transport: "gateway", contract: 7 } },
      cwd: process.cwd(),
    });
    expect(duplicate).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(probe).not.toHaveBeenCalled();
    await adapter.close();
  });
  it("never falls back to ACP for a saved gateway Session when its backend is unavailable", async () => {
    vi.spyOn(HermesGatewayTransport, "probe").mockResolvedValue(null);
    const acp = vi.spyOn(HermesAcpTransport.prototype, "open");
    const adapter = new HermesAdapter({ command: process.execPath });
    const ref = nativeSessionRefSchema.parse({
      harnessId: "hermes",
      nativeSessionId: "gateway",
      formatVersion: 1,
      locator: { transport: "gateway", contract: 7 },
    });
    expect(
      await adapter.open({ kind: "resume", nativeRef: ref, cwd: process.cwd() }),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(acp).not.toHaveBeenCalled();
    await adapter.close();
  });
});
