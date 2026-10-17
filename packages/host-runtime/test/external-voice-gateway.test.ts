import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredExternalVoiceGateway } from "../src/external-voice-gateway.js";

const connections = vi.hoisted(() => [] as { url: string; options: WebSocket.ClientOptions }[]);

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class extends EventEmitter {
      static OPEN = 1;
      readyState = 1;
      send = vi.fn();
      terminate = vi.fn();
      constructor(url: URL, options: WebSocket.ClientOptions) {
        super();
        connections.push({ url: String(url), options });
        queueMicrotask(() => this.emit("open"));
      }
    },
  };
});

const homes: string[] = [];
const input = () => ({
  sdp: "v=0\r\nisolated-offer",
  signal: new AbortController().signal,
  onEvent: vi.fn(),
  onError: vi.fn(),
});

async function gateway(extra = "", provider = 'env_key = "TEST_VOICE_KEY"') {
  const home = await mkdtemp(path.join(tmpdir(), "host-voice-gateway-"));
  homes.push(home);
  await writeFile(
    path.join(home, "config.toml"),
    `model_provider = "selected"
experimental_realtime_webrtc_call_base_url = "https://gateway.example/v1"
${extra}
[model_providers.selected]
${provider}
[model_providers.unselected]
experimental_bearer_token = "wrong-provider-fixture"
`,
  );
  return configuredExternalVoiceGateway({ CODEX_HOME: home, TEST_VOICE_KEY: "env-fixture" });
}

function created() {
  return new Response("v=0\r\nisolated-answer", {
    status: 201,
    headers: { Location: "/v1/realtime/calls/test-call" },
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  connections.length = 0;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("configured voice gateway", () => {
  it.each(["http://[invalid", "/unrecognized", ""])(
    "rejects an unusable call identity without claiming remote cleanup: %s",
    async (location) => {
      const response = new Response("answer", {
        status: 201,
        headers: { Location: location },
      });
      const request = vi.fn<typeof fetch>().mockResolvedValue(response);
      vi.stubGlobal("fetch", request);
      const factory = await gateway();
      await expect(factory(input())).rejects.toThrow("remote cleanup is unconfirmed");
      expect(response.body?.locked).toBe(false);
      expect(request).toHaveBeenCalledTimes(1);
      expect(connections).toHaveLength(0);
    },
  );

  it.each([
    ['env_key = "TEST_VOICE_KEY"', "env-fixture"],
    ['experimental_bearer_token = "bearer-fixture"', "bearer-fixture"],
  ])(
    "uses the selected provider credential for native call and control: %s",
    async (provider, token) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(created())
        .mockResolvedValueOnce(new Response());
      vi.stubGlobal("fetch", request);
      const factory = await gateway("", provider);
      const callbacks = input();
      const call = await factory(callbacks);
      expect(call.sdp).toBe("v=0\r\nisolated-answer");
      const creation = request.mock.calls[0];
      if (!creation) throw new Error("Call creation request is missing");
      const [url, init] = creation;
      expect(url).toBe("https://gateway.example/v1/realtime/calls");
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "OpenAI-Alpha": "quicksilver=v2" },
      });
      const form = init?.body as FormData;
      expect(form.get("sdp")).toBe(callbacks.sdp);
      expect(JSON.parse(String(form.get("session")))).toMatchObject({
        model: "gpt-realtime",
        delegation: { type: "client", ack_filler: false },
        audio: { output: { voice: "cove" } },
      });
      await call.connect();
      expect(connections).toHaveLength(1);
      expect(connections[0]).toMatchObject({
        url: "wss://gateway.example/v1/live/test-call",
        options: { headers: init?.headers, autoSelectFamily: true },
      });
      await Promise.all([call.close(), call.close()]);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]?.[0]).toBe(
        "https://gateway.example/v1/realtime/calls/test-call/hangup",
      );
      await expect(call.connect()).rejects.toThrow("closed");
      expect(callbacks.onError).not.toHaveBeenCalled();
    },
  );

  it.each([
    'experimental_realtime_ws_base_url = "http://gateway.example/v1"',
    'experimental_realtime_ws_base_url = "https://other.example/v1"',
    'experimental_realtime_ws_base_url = "https://user:password@gateway.example/v1"',
    'experimental_realtime_ws_base_url = "https://gateway.example/v1?key=fixture"',
    'experimental_realtime_ws_base_url = "https://gateway.example/v1#fragment"',
    'experimental_realtime_ws_base_url = "malformed-url"',
  ])("rejects unsafe gateway configuration before sending credentials: %s", async (extra) => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const factory = await gateway(extra);
    await expect(factory(input())).rejects.toThrow(/External voice/);
    expect(request).not.toHaveBeenCalled();
  });

  it("never substitutes another provider or OAuth when the selected credential is missing", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const factory = await gateway("", 'env_key = "MISSING_KEY"');
    await expect(factory(input())).rejects.toThrow(
      "configured realtime gateway and API credential",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("does not expose a rejected gateway response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("private-fixture-error", { status: 401 })),
    );
    const factory = await gateway();
    await expect(factory(input())).rejects.toThrow(/^External voice call creation failed$/);
  });

  it("hangs up a call cancelled while its SDP answer is still loading", async () => {
    const body = Promise.withResolvers<string>();
    const response = created();
    vi.spyOn(response, "text").mockImplementation(() => body.promise);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", request);
    const controller = new AbortController();
    const factory = await gateway();
    const starting = factory({ ...input(), signal: controller.signal });
    const rejected = expect(starting).rejects.toThrow("startup failed");
    await vi.waitFor(() => expect(response.text).toHaveBeenCalled());
    controller.abort();
    body.resolve("v=0\r\nlate-answer");
    await rejected;
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toContain("/test-call/hangup");
    expect(request.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    expect(connections).toHaveLength(0);
  });

  it("cleans up a call whose SDP body fails and reports unconfirmed hangup", async () => {
    const response = created();
    vi.spyOn(response, "text").mockRejectedValue(new Error("broken stream"));
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", request);
    const factory = await gateway();
    await expect(factory(input())).rejects.toThrow("hangup was not confirmed");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
