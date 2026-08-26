import { describe, expect, it } from "vitest";

import { OmpHostBridge } from "../src/omp-host-bridge.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("OMP Host bridge", () => {
  it("executes registered Host Tools and streams updates", async () => {
    const frames: Record<string, unknown>[] = [];
    const failures: Error[] = [];
    const bridge = new OmpHostBridge({
      send: async (frame) => frames.push(frame),
      onFailure: (error) => failures.push(error),
      tools: [
        {
          name: "lookup",
          label: "Lookup",
          description: "Look up a value",
          parameters: { type: "object", properties: {} },
          async execute(call, _signal, onUpdate) {
            expect(call).toMatchObject({
              id: "rpc-tool-1",
              toolCallId: "model-tool-1",
              toolName: "lookup",
              arguments: { query: "omp" },
            });
            onUpdate({ content: [{ type: "text", text: "working" }] });
            return { content: [{ type: "text", text: "done" }], details: { count: 1 } };
          },
        },
      ],
    });

    expect(bridge.toolDefinitions()).toEqual([
      {
        name: "lookup",
        label: "Lookup",
        description: "Look up a value",
        parameters: { type: "object", properties: {} },
      },
    ]);
    expect(
      bridge.handleFrame({
        type: "host_tool_call",
        id: "rpc-tool-1",
        toolCallId: "model-tool-1",
        toolName: "lookup",
        arguments: { query: "omp" },
      }),
    ).toBe(true);
    await flush();
    expect(frames).toEqual([
      {
        type: "host_tool_update",
        id: "rpc-tool-1",
        partialResult: { content: [{ type: "text", text: "working" }] },
      },
      {
        type: "host_tool_result",
        id: "rpc-tool-1",
        result: { content: [{ type: "text", text: "done" }], details: { count: 1 } },
      },
    ]);
    expect(failures).toEqual([]);
    bridge.close();
  });

  it("cancels pending Host Tool and URI requests without sending stale results", async () => {
    const frames: Record<string, unknown>[] = [];
    const toolAborted = new Promise<void>((resolve) => {
      const bridge = new OmpHostBridge({
        send: async (frame) => frames.push(frame),
        onFailure: () => undefined,
        tools: [
          {
            name: "slow",
            description: "Slow tool",
            parameters: { type: "object" },
            async execute(_call, signal) {
              await new Promise<void>((resolveWait) => {
                signal.addEventListener("abort", () => {
                  resolveWait();
                  resolve();
                });
              });
              throw new Error("aborted");
            },
          },
        ],
        uriSchemes: [
          {
            scheme: "db",
            writable: true,
            async resolve(_request, signal) {
              await new Promise<void>((resolveWait) =>
                signal.addEventListener("abort", resolveWait),
              );
              throw new Error("aborted");
            },
          },
        ],
      });
      bridge.handleFrame({
        type: "host_tool_call",
        id: "tool-1",
        toolCallId: "model-tool-1",
        toolName: "slow",
        arguments: {},
      });
      bridge.handleFrame({ type: "host_tool_cancel", id: "cancel-1", targetId: "tool-1" });
      bridge.handleFrame({
        type: "host_uri_request",
        id: "uri-1",
        operation: "read",
        url: "db://x",
      });
      bridge.handleFrame({ type: "host_uri_cancel", id: "cancel-2", targetId: "uri-1" });
    });
    await toolAborted;
    await flush();
    expect(frames).toEqual([]);
  });

  it("routes URI reads and rejects writes to read-only schemes", async () => {
    const frames: Record<string, unknown>[] = [];
    const bridge = new OmpHostBridge({
      send: async (frame) => frames.push(frame),
      onFailure: () => undefined,
      uriSchemes: [
        {
          scheme: "docs",
          immutable: true,
          async resolve(request) {
            return request.operation === "read"
              ? { content: "# OMP", contentType: "text/markdown", notes: ["cached"] }
              : {};
          },
        },
      ],
    });
    expect(bridge.uriSchemeDefinitions()).toEqual([{ scheme: "docs", immutable: true }]);
    bridge.handleFrame({
      type: "host_uri_request",
      id: "read-1",
      operation: "read",
      url: "docs://guide",
    });
    bridge.handleFrame({
      type: "host_uri_request",
      id: "write-1",
      operation: "write",
      url: "docs://guide",
      content: "new",
    });
    await flush();
    expect(frames).toHaveLength(2);
    expect(frames).toContainEqual({
      type: "host_uri_result",
      id: "read-1",
      content: "# OMP",
      contentType: "text/markdown",
      notes: ["cached"],
    });
    expect(frames).toContainEqual({
      type: "host_uri_result",
      id: "write-1",
      isError: true,
      error: "OMP Host URI scheme is read-only: docs",
    });
    bridge.close();
  });
});
