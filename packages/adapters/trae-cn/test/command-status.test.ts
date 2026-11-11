import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { projectHistory } from "../src/history.js";

const { withCommandStatuses } = createRequire(import.meta.url)("../assets/companion/commands.cjs");
// TRAE CN 3.4.13 native running/completed responses, with IDs, paths and output normalized.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/native-background-command.json", import.meta.url), "utf8"),
);
function assistant() {
  return {
    role: "assistant",
    chat_session_id: "session",
    message_id: "native-assistant",
    message_index: 2,
    reply_to_message_id: "native-user",
    status: "completed",
    content: JSON.stringify({ messages: [{ type: "plan_item", plan_item: fixture.plan }] }),
  };
}
function history(reply: unknown) {
  return {
    sessionId: "session",
    items: [
      {
        role: "user",
        chat_session_id: "session",
        message_id: "native-user",
        message_index: 1,
        content: JSON.stringify([{ type: "text", text_content: "Run in background" }]),
      },
      reply,
    ],
  };
}

describe("TRAE CN observed background command history", () => {
  it("does not query an execution after native launch denial", async () => {
    const denied = assistant(),
      content = JSON.parse(denied.content);
    content.messages[0].plan_item.tool_call_info.result = {
      status: "failed",
      data: { exit_code: 1 },
    };
    denied.content = JSON.stringify(content);
    const call = vi.fn();
    expect(await withCommandStatuses({ call }, denied, "session", "project")).toEqual(denied);
    expect(call).not.toHaveBeenCalled();
  });
  it("reads the native result with original selectors and preserves actual output/outcome", async () => {
    const call = vi.fn(async () => fixture.completed);
    const enriched = await withCommandStatuses({ call }, assistant(), "session", "project");
    expect(call).toHaveBeenCalledExactlyOnceWith(
      "toolcall",
      "check_toolhost_command_status",
      {
        session_id: "session",
        command_id: "native-command",
        tool_call_id: "native-tool-call",
        plan_item_id: "native-plan",
        output_character_count: 16384,
        output_priority: "bottom",
      },
      { chat_session_id: "session", project_id: "project" },
    );
    const item = projectHistory(history(enriched), "session", "builder_v3").turns[0]?.items[0];
    expect(item).toMatchObject({
      item: { type: "commandExecution", command: "echo DONE", output: "DONE\r\n", exitCode: 0 },
      outcome: { status: "succeeded" },
    });
    expect(item?.item).not.toHaveProperty("durationMs"); // launch timing is not execution timing
    expect(JSON.stringify(item)).not.toContain("[Background Job]");
  });

  it("keeps a running command unresolved even when the parent message completed", async () => {
    const enriched = await withCommandStatuses(
      { call: async () => fixture.running },
      assistant(),
      "session",
      "project",
    );
    expect(() => projectHistory(history(enriched), "session", "builder_v3")).toThrowError(
      expect.objectContaining({ code: "sessionBusy" }),
    );
  });

  it.each([
    ["commandId", "foreign"],
    ["command", "different command"],
    ["cwd", "/foreign"],
    ["status", "unknown"],
    ["stdout_complete", "invalid"],
    ["exit_code", null],
    ["total_bytes", -1],
    ["output", "x".repeat(16385)],
  ])("rejects invalid native %s", async (key, value) => {
    const response = structuredClone(fixture.completed);
    if (key === "commandId") response.commandId = value;
    else response.result[key] = value;
    await expect(
      withCommandStatuses({ call: async () => response }, assistant(), "session", "project"),
    ).rejects.toMatchObject({ code: "protocolError" });
  });

  it("keeps observing after process exit until native output is completely flushed", async () => {
    const response = structuredClone(fixture.completed);
    response.result.stdout_complete = false;
    const enriched = await withCommandStatuses(
      { call: async () => response },
      assistant(),
      "session",
      "project",
    );
    expect(enriched.commandStatuses[0]).toMatchObject({ status: "running" });
    expect(enriched.commandStatuses[0]).not.toHaveProperty("exitCode");
    expect(() => projectHistory(history(enriched), "session", "builder_v3")).toThrowError(
      expect.objectContaining({ code: "sessionBusy" }),
    );
  });

  it("reports lost native execution state instead of relaunching it", async () => {
    const call = vi.fn(async () => ({ found: false }));
    await expect(
      withCommandStatuses({ call }, assistant(), "session", "project"),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(call.mock.calls).toHaveLength(1);
  });

  it("rejects foreign/duplicate/orphan status entries in a public history snapshot", async () => {
    const enriched = await withCommandStatuses(
      { call: async () => fixture.completed },
      assistant(),
      "session",
      "project",
    );
    for (const statuses of [
      [{ ...enriched.commandStatuses[0], messageId: "foreign" }],
      [{ ...enriched.commandStatuses[0], commandId: "foreign" }],
      [{ ...enriched.commandStatuses[0], planItemId: "foreign" }],
      [...enriched.commandStatuses, ...enriched.commandStatuses],
    ])
      expect(() =>
        projectHistory(
          history({ ...enriched, commandStatuses: statuses }),
          "session",
          "builder_v3",
        ),
      ).toThrowError(expect.objectContaining({ code: "protocolError" }));
  });

  it("preserves nonzero exits and actual native cancellation", async () => {
    for (const aborted of [false, true]) {
      const response = structuredClone(fixture.completed);
      response.result.exit_code = 7;
      response.result.user_aborted = aborted;
      const enriched = await withCommandStatuses(
        { call: async () => response },
        assistant(),
        "session",
        "project",
      );
      expect(
        projectHistory(history(enriched), "session", "builder_v3").turns[0]?.items[0],
      ).toMatchObject({ outcome: { status: aborted ? "cancelled" : "failed" } });
    }
  });
});
