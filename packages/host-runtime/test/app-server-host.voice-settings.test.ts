import { expect, it, vi } from "vitest";
import { VOICE_SETTINGS_METHOD, VOICE_GATEWAY_STATUS_METHOD } from "@codexhost/shared-contracts";
import { createFixture, stopFixture, writeRequest, requestId } from "./app-server-host-fixture.js";

it("validates voice settings and proxies only through the local console service", async () => {
  const voiceSettings = vi.fn(async () => ({ settings: "fixture" }));
  const fixture = createFixture({
    environment: { CODEX_HOME: "/nonexistent-codexhost-voice-test" },
    consoleOpener: { open: vi.fn(), voiceSettings },
  });
  try {
    writeRequest(fixture.desktopInput, {
      id: 801,
      method: VOICE_SETTINGS_METHOD,
      params: { operation: "get" },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 801))).toMatchObject({
      result: { settings: "fixture" },
    });
    expect(voiceSettings).toHaveBeenCalledWith({ operation: "get" });
    writeRequest(fixture.desktopInput, {
      id: 802,
      method: VOICE_SETTINGS_METHOD,
      params: { operation: "set", settings: {} },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 802))).toMatchObject({
      error: { code: -32602 },
    });
    expect(voiceSettings).toHaveBeenCalledOnce();
    expect(fixture.official.stdin.readableLength).toBe(0);
    expect(
      await fixture.host.handleConsoleRequest(VOICE_SETTINGS_METHOD, { operation: "get" }),
    ).toMatchObject({ error: { code: -32601 } });
    expect(await fixture.host.handleConsoleRequest(VOICE_GATEWAY_STATUS_METHOD, {})).toEqual({
      result: false,
    });
  } finally {
    await stopFixture(fixture);
  }
});

it("rejects voice operations when there is no local console service", async () => {
  const fixture = createFixture();
  try {
    writeRequest(fixture.desktopInput, {
      id: 803,
      method: VOICE_SETTINGS_METHOD,
      params: { operation: "get" },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 803))).toMatchObject({
      error: { code: -32090 },
    });
  } finally {
    await stopFixture(fixture);
  }
});
