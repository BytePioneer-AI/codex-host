import { describe, expect, it, vi } from "vitest";
import { PiSubagentRpc } from "../src/pi-subagent-rpc.js";
import { piSubagentId } from "../src/pi-subagents.js";

function reply(requestId: string, extra: Record<string, unknown> = {}) {
  return {
    type: "extension_ui_request",
    method: "setWidget",
    widgetKey: "subagent-inspect",
    widgetLines: [
      "PI_SUBAGENT_INSPECT_JSON:" +
        JSON.stringify({
          kind: "pi-subagents.inspect-reply",
          version: 1,
          requestId,
          asyncId: "run-1",
          status: "complete",
          finalOutput: "done",
          ...extra,
        }),
    ],
  };
}
const commands = { data: { commands: [{ name: "subagents-inspect-rpc", source: "extension" }] } };

describe("Pi subagent RPC side channel", () => {
  it("correlates inline inspection without creating a model Turn and drops unmatched replies", async () => {
    const send = vi.fn(async (type: string, payload: Record<string, unknown>) => {
      if (type === "get_commands") return commands;
      const requestId = String(payload.message).split(" ")[1];
      if (!requestId) throw new Error("Missing correlation id");
      rpc.handle(reply("unmatched"));
      rpc.handle(reply(requestId));
      rpc.handle({
        type: "extension_ui_request",
        method: "setWidget",
        widgetKey: "subagent-inspect",
      });
      return {};
    });
    const rpc = new PiSubagentRpc(send, 100);
    expect(await rpc.inspect(piSubagentId({ runId: "run-1" }))).toMatchObject({
      finalOutput: "done",
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[1]).toMatchObject({
      message: expect.stringMatching(/^\/subagents-inspect-rpc [\w-]+ run-1 --lines 200$/),
    });
    rpc.close();
  });

  it("never sends a slash prompt if the native extension command is missing or is only a prompt template", async () => {
    for (const source of [undefined, "prompt"]) {
      const send = vi.fn(async () => ({
        data: { commands: [{ name: "subagents-inspect-rpc", source }] },
      }));
      const rpc = new PiSubagentRpc(send, 100);
      await expect(rpc.inspect(piSubagentId({ runId: "run-1" }))).rejects.toThrow(
        "no pi-subagents",
      );
      expect(send).toHaveBeenCalledTimes(1);
      rpc.close();
    }
  });

  it("rejects mismatched identities and propagates session-scoped native errors", async () => {
    for (const extra of [
      { asyncId: "wrong-run" },
      { error: { code: "foreign_session", message: "Not owned" } },
    ]) {
      const rpc = new PiSubagentRpc(async (type, payload) => {
        if (type === "get_commands") return commands;
        rpc.handle(reply(String(payload.message).split(" ")[1] ?? "", extra));
        return {};
      }, 100);
      const pending = rpc.inspect(piSubagentId({ runId: "run-1" }));
      if ("error" in extra) expect(await pending).toMatchObject({ error: extra.error });
      else await expect(pending).rejects.toThrow("identity");
      rpc.close();
    }
  });

  it("times out unmatched/future replies and rejects pending inspections on close", async () => {
    const rpc = new PiSubagentRpc(async (type) => (type === "get_commands" ? commands : {}), 10);
    await expect(rpc.inspect(piSubagentId({ runId: "run-1" }))).rejects.toThrow("timed out");
    const pending = rpc.inspect(piSubagentId({ runId: "run-1" }));
    const rejection = expect(pending).rejects.toThrow("closed");
    await Promise.resolve();
    rpc.close();
    await rejection;
  });

  it("replays a status widget received before Session binding and consumes malformed widget frames", () => {
    const rpc = new PiSubagentRpc(async () => ({}), 100);
    expect(
      rpc.handle({
        type: "extension_ui_request",
        method: "setWidget",
        widgetKey: "subagent-async",
        widgetLines: [
          'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","version":1,"runs":[]}',
        ],
      }),
    ).toBe(true);
    const handler = vi.fn();
    rpc.setHandler(handler);
    expect(handler).toHaveBeenCalledWith([]);
    expect(
      rpc.handle({
        type: "extension_ui_request",
        method: "setWidget",
        widgetKey: "subagent-async",
        widgetLines: ["bad"],
      }),
    ).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(rpc.handle({ type: "extension_ui_request", method: "select" })).toBe(false);
    rpc.close();
  });
});
