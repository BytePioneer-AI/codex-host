import { describe, expect, it } from "vitest";

import {
  assertCompatible,
  isOmoResponseFrame,
  OMO_MAX_FRAME_BYTES,
  OMO_PROTOCOL_VERSION,
  OMO_REQUIRED_CAPABILITIES,
  OmoJsonlFramer,
  OmoProtocolError,
  parseOmoFrame,
  parseOmoProtocolInfo,
  type OmoFrame,
  type OmoProtocolInfo,
} from "../src/omo-protocol.js";

const encoder = new TextEncoder();

/**
 * Shapes observed from a live `omo 5.1.83` probe on 2026-11-26. Values are
 * synthetic; only the field layout and capability identifiers are reproduced.
 * `dynamic_versions` is nested under `method_classes`, as the engine sends it.
 */
const liveCapabilities = [
  "multi_session",
  "snapshot_cursor",
  "ui_answer_ledger",
  "session_lifecycle",
  "auto_title_sessions",
  "media_placeholders",
  "secret_input_v1",
  "durable_client_message_id",
  "effect_ledger",
  "steer_when_idle",
  "continue_from_leaf",
  "eval_cells",
  "auth_key_verify",
  "provider_account_test",
  "account_reset",
  "queued_message_revision",
  "tool_barrier",
  "user_activity",
  "session_model_scope",
  "resume_session",
  "entries_tail",
  "set_permission_preset_v1",
  "retry_fallback_command",
  "tool_runtime:in-process",
  "offload_api",
] as const;

const liveDynamicVersions = {
  get_effect_status: 1,
  prompt: 1,
  steer: 1,
  follow_up: 1,
  set_thinking_level: 1,
  set_model: 1,
  append_session_entry: 1,
  new_session: 1,
  open_session: 2,
} as const;

const liveProtocolInfo = {
  protocolVersion: 1,
  serverVersion: "5.1.83",
  capabilities: [...liveCapabilities],
  mode: "classic",
  engineVersion: "5.1.83",
  engineOrdinal: [5, 1, 83, 0, 0],
  launch_profile: {
    profile_id: "synthetic-profile-id",
    core: { extensions: [], multi_session: false, session_runtime: "worker" },
  },
  agentDir: "/tmp/omo-agent",
  method_classes: {
    version: 1,
    digest: "synthetic-digest",
    classes: { get_protocol_info: "observe", prompt: "dynamic", open_session: "dynamic" },
    dynamic_versions: liveDynamicVersions,
  },
};

const liveProtocolInfoResponse = {
  id: "protocol-1",
  type: "response",
  command: "get_protocol_info",
  success: true,
  data: liveProtocolInfo,
};

function encodeLine(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function pushText(framer: OmoJsonlFramer, text: string): OmoFrame[] {
  return framer.push(encoder.encode(text));
}

function captureProtocolError(run: () => unknown): OmoProtocolError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OmoProtocolError);
    return error as OmoProtocolError;
  }
  throw new Error("expected the call to throw OmoProtocolError");
}

function infoFor(
  serverVersion: string,
  options: { protocolVersion?: number; capabilities?: readonly string[] } = {},
): OmoProtocolInfo {
  return parseOmoProtocolInfo({
    protocolVersion: options.protocolVersion ?? OMO_PROTOCOL_VERSION,
    serverVersion,
    capabilities: options.capabilities ?? [...liveCapabilities],
  });
}

describe("LF-only JSONL framing", () => {
  it("parses multiple frames delivered in one chunk", () => {
    const framer = new OmoJsonlFramer();
    const frames = framer.push(
      encoder.encode(
        `${JSON.stringify({
          type: "response",
          id: "state-1",
          success: true,
          command: "get_state",
          data: { sessionId: "session-1" },
        })}\n${JSON.stringify({ type: "turn_start", turnId: "turn-1" })}\n`,
      ),
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      type: "response",
      id: "state-1",
      success: true,
      command: "get_state",
      data: { sessionId: "session-1" },
    });
    expect(frames[1]).toEqual({ type: "turn_start", turnId: "turn-1" });
  });

  it("buffers frames split across chunks anywhere, including inside UTF-8 characters", () => {
    const first = { type: "message_update", text: "😺 first" };
    const second = {
      type: "response",
      id: "prompt-1",
      success: false,
      error: "streaming",
      errorCode: "streaming",
    };
    const bytes = new Uint8Array([...encodeLine(first), ...encodeLine(second)]);
    const firstNewline = bytes.indexOf(0x0a);
    expect(firstNewline).toBeGreaterThan(0);

    const framer = new OmoJsonlFramer();
    const frames: OmoFrame[] = [];
    for (let index = 0; index < bytes.length; index += 1) {
      const produced = framer.push(bytes.subarray(index, index + 1));
      if (index < firstNewline) expect(produced).toHaveLength(0);
      frames.push(...produced);
    }

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: "message_update", text: "😺 first" });
    expect(frames[1]).toEqual({
      type: "response",
      id: "prompt-1",
      success: false,
      error: "streaming",
      errorCode: "streaming",
    });
  });

  it("does not split on U+2028 or U+2029 inside a JSON string", () => {
    const message = "before\u2028middle\u2029after";
    const line = JSON.stringify({ type: "model_changed", message });
    expect(line).toContain("\u2028");
    expect(line).toContain("\u2029");
    const bytes = encoder.encode(`${line}\n`);
    const firstSeparator = bytes.indexOf(0xe2);
    const lastSeparator = bytes.lastIndexOf(0xe2);
    expect(firstSeparator).toBeGreaterThan(0);
    expect(lastSeparator).toBeGreaterThan(firstSeparator);

    const framer = new OmoJsonlFramer();
    expect(framer.push(bytes.subarray(0, firstSeparator))).toHaveLength(0);
    expect(framer.push(bytes.subarray(firstSeparator, lastSeparator))).toHaveLength(0);
    const frames = framer.push(bytes.subarray(lastSeparator));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "model_changed", message });
  });

  it("accepts CRLF terminators and skips empty lines", () => {
    const framer = new OmoJsonlFramer();
    const frames = pushText(
      framer,
      `${JSON.stringify({ type: "agent_start" })}\r\n\n\r\n${JSON.stringify({
        type: "agent_settled",
      })}\r\n`,
    );

    expect(frames).toEqual([{ type: "agent_start" }, { type: "agent_settled" }]);
  });

  it("rejects a frame larger than 16 MiB with a typed error and stays failed", () => {
    const framer = new OmoJsonlFramer();
    const oversized = new Uint8Array(OMO_MAX_FRAME_BYTES + 2);
    oversized.fill(0x20);

    const error = captureProtocolError(() => framer.push(oversized));
    expect(error.kind).toBe("frame_too_large");
    expect(error.message).toContain(String(OMO_MAX_FRAME_BYTES));
    expect(captureProtocolError(() => framer.push(encoder.encode("{}\n"))).kind).toBe(
      "framing_failed",
    );
  });

  it("accepts a large frame that stays within the cap", () => {
    const payload = "x".repeat(2 * 1024 * 1024);
    const frames = new OmoJsonlFramer().push(encodeLine({ type: "message_update", payload }));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "message_update", payload });
    expect(frames[0]?.payload).toHaveLength(payload.length);
  });

  it("reports an incomplete frame at stream end instead of returning a partial value", () => {
    const framer = new OmoJsonlFramer();
    expect(pushText(framer, '{"type":"response","id":"half"')).toHaveLength(0);

    const error = captureProtocolError(() => framer.finish());
    expect(error.kind).toBe("truncated_frame");
    expect(error.message).toContain("incomplete frame");
  });

  it("rejects invalid UTF-8 bytes with a typed error", () => {
    const framer = new OmoJsonlFramer();
    const error = captureProtocolError(() => framer.push(new Uint8Array([0x7b, 0xff, 0x0a])));

    expect(error.kind).toBe("invalid_encoding");
  });

  it("skips empty lines but rejects whitespace-only lines", () => {
    const framer = new OmoJsonlFramer();
    expect(pushText(framer, "\n\n")).toEqual([]);
    expect(captureProtocolError(() => pushText(framer, "   \n")).kind).toBe("invalid_json");
  });

  it.each(["42\n", "[]\n", "null\n", '"a string"\n'])(
    "rejects the non-object JSON record %j",
    (text) => {
      const framer = new OmoJsonlFramer();
      expect(captureProtocolError(() => pushText(framer, text)).kind).toBe("invalid_frame");
    },
  );

  it("rejects a response frame without a string id and boolean success", () => {
    const error = captureProtocolError(() =>
      parseOmoFrame({ type: "response", id: "missing-success" }),
    );

    expect(error.kind).toBe("invalid_frame");
  });

  it("parses an unknown event type without error so callers can ignore it", () => {
    const frames = pushText(
      new OmoJsonlFramer(),
      '{"type":"future_event_2027","payload":{"nested":[1,2]}}\n',
    );

    expect(frames).toEqual([{ type: "future_event_2027", payload: { nested: [1, 2] } }]);
  });

  it("keeps additive response fields alongside the typed ones", () => {
    const frames = pushText(
      new OmoJsonlFramer(),
      `${JSON.stringify({
        type: "response",
        id: "prompt-2",
        success: false,
        error: "session busy",
        errorCode: "streaming",
        command: "prompt",
        errorData: { reason: "streaming", action: "retry" },
      })}\n`,
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "response",
      id: "prompt-2",
      success: false,
      error: "session busy",
      errorCode: "streaming",
      command: "prompt",
      errorData: { reason: "streaming", action: "retry" },
    });
  });
});

describe("get_protocol_info negotiation", () => {
  it("parses the live 5.1.83 handshake shape into typed values", () => {
    const frames = new OmoJsonlFramer().push(encodeLine(liveProtocolInfoResponse));
    expect(frames).toHaveLength(1);
    const [frame] = frames;
    expect(frame).toMatchObject({
      type: "response",
      id: "protocol-1",
      success: true,
      command: "get_protocol_info",
    });
    if (frame === undefined || !isOmoResponseFrame(frame)) {
      throw new Error("expected a get_protocol_info response frame");
    }

    const info = parseOmoProtocolInfo(frame.data);
    expect(info.protocolVersion).toBe(1);
    expect(info.serverVersion).toBe("5.1.83");
    expect(info.capabilities).toHaveLength(25);
    expect(info.capabilities[24]).toBe("offload_api");
    expect(info.dynamicVersions).toEqual(liveDynamicVersions);
    expect(info.dynamicVersions.open_session).toBe(2);
    expect(info.dynamicVersions.prompt).toBe(1);
    expect(info.engineOrdinal).toEqual([5, 1, 83, 0, 0]);
    expect(info.mode).toBe("classic");
    expect(info.hasCapability("set_permission_preset_v1")).toBe(true);
    expect(info.hasCapability("not_a_real_capability")).toBe(false);
    expect(() => assertCompatible(info)).not.toThrow();
  });

  it("tolerates a 27-entry additive capability set", () => {
    const info = parseOmoProtocolInfo({
      ...liveProtocolInfo,
      capabilities: [...liveCapabilities, "future_query_v2", "future_stream_v3"],
    });

    expect(info.capabilities).toHaveLength(27);
    expect(info.capabilities.slice(-2)).toEqual(["future_query_v2", "future_stream_v3"]);
    expect(info.hasCapability("future_query_v2")).toBe(true);
    expect(info.hasCapability("future_stream_v3")).toBe(true);
    expect(() => assertCompatible(info)).not.toThrow();
  });

  it("reads dynamic_versions from the top level when it is not nested", () => {
    const info = parseOmoProtocolInfo({
      protocolVersion: 1,
      serverVersion: "5.1.83",
      capabilities: [],
      dynamic_versions: { prompt: 1, open_session: 2 },
    });

    expect(info.dynamicVersions).toEqual({ prompt: 1, open_session: 2 });
  });

  it.each([
    ["null data", null],
    ["a missing protocolVersion", { serverVersion: "5.1.83", capabilities: [] }],
    [
      "a fractional protocolVersion",
      { protocolVersion: 1.5, serverVersion: "5.1.83", capabilities: [] },
    ],
    ["a missing serverVersion", { protocolVersion: 1, capabilities: [] }],
    [
      "a non-string capability",
      { protocolVersion: 1, serverVersion: "5.1.83", capabilities: ["ok", 2] },
    ],
    [
      "a non-array capabilities field",
      { protocolVersion: 1, serverVersion: "5.1.83", capabilities: "prompt" },
    ],
    [
      "a non-object dynamic_versions",
      { protocolVersion: 1, serverVersion: "5.1.83", capabilities: [], dynamic_versions: 3 },
    ],
    [
      "a non-numeric engineOrdinal",
      {
        protocolVersion: 1,
        serverVersion: "5.1.83",
        capabilities: [],
        engineOrdinal: [5, 1, "83"],
      },
    ],
    [
      "a non-string mode",
      { protocolVersion: 1, serverVersion: "5.1.83", capabilities: [], mode: 1 },
    ],
  ])("rejects malformed protocol info: %s", (_label, value) => {
    const error = captureProtocolError(() => parseOmoProtocolInfo(value));
    expect(error.kind).toBe("invalid_protocol_info");
  });
});

describe("compatibility gate", () => {
  it.each(["5.1.83", "5.2.0", "5.10.0", "6.0.1", "2026.11.23"])(
    "accepts protocol 1 with serverVersion %s",
    (version) => {
      expect(() => assertCompatible(infoFor(version))).not.toThrow();
    },
  );

  it("rejects protocolVersion 2 with a typed error", () => {
    const error = captureProtocolError(() =>
      assertCompatible(infoFor("5.1.83", { protocolVersion: 2 })),
    );

    expect(error.kind).toBe("incompatible_protocol");
    expect(error.message).toContain("expected 1");
  });

  it.each(["5.1.82", "5.1.9", "5.1.83-beta.1"])(
    "rejects serverVersion %s as older than the 5.1.83 floor",
    (version) => {
      const error = captureProtocolError(() => assertCompatible(infoFor(version)));

      expect(error.kind).toBe("incompatible_server_version");
      expect(error.message).toContain("5.1.83");
    },
  );

  it("rejects a non-semver serverVersion with a typed error", () => {
    const error = captureProtocolError(() => assertCompatible(infoFor("omo 5.1.83")));

    expect(error.kind).toBe("incompatible_server_version");
    expect(error.message).toContain("not a semantic version");
  });

  it("leaves the v1 required-capability list empty and enforces an injected list", () => {
    expect(OMO_REQUIRED_CAPABILITIES).toEqual([]);
    const info = infoFor("5.1.83");

    expect(() => assertCompatible(info, ["set_permission_preset_v1"])).not.toThrow();
    const error = captureProtocolError(() => assertCompatible(info, ["needs_future_capability"]));
    expect(error.kind).toBe("missing_capability");
    expect(error.message).toContain("needs_future_capability");
  });
});
