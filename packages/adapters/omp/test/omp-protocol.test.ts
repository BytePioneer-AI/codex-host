import { describe, expect, it } from "vitest";

import {
  OmpFrameDecoder,
  parseOmpNotification,
  textDeltaFromOmpNotification,
} from "../src/omp-protocol.js";

describe("OMP RPC protocol", () => {
  it("decodes a ready notification", () => {
    expect(
      parseOmpNotification({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      }),
    ).toEqual({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
    });
  });

  it("reassembles a protocol v2 chunk sequence", () => {
    const decoder = new OmpFrameDecoder();
    const encoded = Buffer.from(
      JSON.stringify({ type: "agent_end", isTerminal: true, padding: "x".repeat(1024 * 1024) }),
      "utf8",
    );
    const chunkSize = 256 * 1024;
    const count = Math.ceil(encoded.length / chunkSize);
    for (let index = 0; index < count; index += 1) {
      const chunk = encoded.subarray(index * chunkSize, (index + 1) * chunkSize);
      const result = decoder.push({
        type: "rpc_chunk",
        chunkId: "chunk-1",
        index,
        count,
        byteLength: encoded.length,
        data: chunk.toString("base64"),
      });
      if (index < count - 1) expect(result).toBeNull();
      else expect(result).toMatchObject({ type: "agent_end", isTerminal: true });
    }
  });

  it("maps OMP message updates and terminal events", () => {
    expect(
      textDeltaFromOmpNotification(
        parseOmpNotification({
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
          assistantMessageEvent: { type: "text_delta", delta: "hi" },
        }) as Extract<ReturnType<typeof parseOmpNotification>, { type: "message_update" }>,
      ),
    ).toEqual({ messageId: "assistant", delta: "hi" });
    expect(parseOmpNotification({ type: "agent_end", isTerminal: true })).toEqual({
      type: "agent_end",
      isTerminal: true,
    });
  });

  it("maps native Subagent lifecycle and progress frames", () => {
    expect(
      parseOmpNotification({
        type: "subagent_lifecycle",
        payload: {
          id: "subagent-1",
          index: 0,
          agent: "task",
          agentSource: "bundled",
          status: "started",
          description: "Inspect the repository",
          sessionFile: "/tmp/subagent.jsonl",
          parentToolCallId: "tool-1",
        },
      }),
    ).toMatchObject({
      type: "subagent_lifecycle",
      payload: {
        id: "subagent-1",
        status: "started",
        parentToolCallId: "tool-1",
      },
    });
    expect(
      parseOmpNotification({
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "task",
          agentSource: "bundled",
          task: "Inspect the repository",
          progress: { id: "subagent-1", status: "running", recentOutput: [] },
          parentToolCallId: "tool-1",
        },
      }),
    ).toMatchObject({
      type: "subagent_progress",
      payload: {
        progress: { id: "subagent-1", status: "running" },
      },
    });
  });
});
