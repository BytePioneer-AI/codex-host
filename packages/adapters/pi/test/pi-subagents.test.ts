import { describe, expect, it } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { mapPiSnapshot } from "../src/pi-history.js";
import {
  PiSubagents,
  parsePiSubagentStatus,
  parsePiSubagentInspection,
  parsePiSubagentId,
  piSubagentId,
  piSubagentSnapshot,
  type PiSubagentNode,
} from "../src/pi-subagents.js";

const turnId = hostTurnIdSchema.parse("turn-1");
const itemId = hostItemIdSchema.parse("item-1");
const launch = {
  details: { mode: "workflow", results: [], asyncId: "run-1", asyncDir: "/tmp/run-1" },
};
const run = (state = "running"): PiSubagentNode => ({
  id: "run-1",
  kind: "workflow",
  label: "Review",
  state,
  children: [
    { id: "security", kind: "step", label: "Security", state },
    { id: "tests", kind: "step", label: "Tests", state },
    { id: "gate", kind: "host-step", label: "Gate", state },
  ],
});
const widget = (payload: unknown, key = "subagent-async", prefix = "PI_SUBAGENT_ASYNC_JSON:") => ({
  type: "extension_ui_request",
  method: "setWidget",
  widgetKey: key,
  widgetLines: [prefix + JSON.stringify(payload)],
});

describe("Pi pi-subagents protocol projection", () => {
  it("recognizes only the versioned machine widget and uses native widgetLines", () => {
    const payload = {
      kind: "pi-subagents.async-status-snapshot",
      version: 1,
      runs: [run()],
      extra: true,
    };
    expect(parsePiSubagentStatus(widget(payload))).toEqual([run()]);
    expect(parsePiSubagentStatus(widget({ ...payload, version: 2 }))).toBeNull();
    expect(parsePiSubagentStatus({ ...widget(payload), widgetKey: "other" })).toBeNull();
    expect(
      parsePiSubagentStatus({ ...widget(payload), widgetLines: ["PI_SUBAGENT_ASYNC_JSON:{"] }),
    ).toBeNull();
    expect(
      parsePiSubagentStatus(widget({ ...payload, runs: [{ ...run(), state: "new-state" }] })),
    ).toBeNull();
    expect(parsePiSubagentStatus(widget({ ...payload, padding: "x".repeat(66000) }))).toBeNull();
  });

  it("round trips stable run/child identities and rejects slash-command injection", () => {
    const id = piSubagentId({ runId: "run-1", childId: "step:0" });
    expect(parsePiSubagentId(id)).toEqual({ runId: "run-1", childId: "step:0" });
    expect(piSubagentId({ runId: "run-2", childId: "step:0" })).not.toBe(id);
    expect(() => parsePiSubagentId(piSubagentId({ runId: "run-1 --lines 1" }))).toThrow();
    expect(() => parsePiSubagentId(id + "=")).toThrow();
    expect(() => parsePiSubagentId("native-file-path")).toThrow();
  });

  it("does not classify unknown same-named tools, foreground results, or status queries as delegation", () => {
    const observer = new PiSubagents(() => undefined);
    expect(observer.project("subagent", launch, itemId)).toBeNull();
    observer.observe([run()]);
    expect(observer.project("other", launch, itemId)).toBeNull();
    expect(
      observer.project("subagent", { details: { ...launch.details, mode: "management" } }, itemId),
    ).toBeNull();
    expect(
      observer.project("subagent", { details: { mode: "single", results: [] } }, itemId),
    ).toBeNull();
  });

  it("maps parallel children separately, excludes host gates, and does not complete them when the parent finishes", () => {
    const events: HostEvent[] = [];
    const observer = new PiSubagents((event) => events.push(event));
    observer.observe([run()]);
    observer.start(turnId, "subagent", launch, itemId);
    observer.finish(turnId);
    const completed = events.find((event) => event.type === "item.completed");
    expect(completed).toMatchObject({
      snapshot: {
        item: {
          subagents: [
            { description: "Security", status: "running" },
            { description: "Tests", status: "running" },
          ],
        },
        outcome: { status: "succeeded" },
      },
    });
    events.length = 0;
    observer.observe([run("complete")]);
    expect(events.filter((event) => event.type === "subagent.state.changed")).toHaveLength(2);
    expect(events).toContainEqual({
      type: "subagent.state.changed",
      nativeSubagentId: piSubagentId({ runId: "run-1", childId: "security" }),
      status: "completed",
    });
    expect(
      events.some((event) => event.type === "item.updated" || event.type === "turn.completed"),
    ).toBe(false);
  });

  it("accepts status arriving after the launch response, and does not settle omitted children", () => {
    const events: HostEvent[] = [];
    const observer = new PiSubagents((event) => events.push(event));
    observer.start(turnId, "subagent", launch, itemId);
    expect(events).toEqual([]);
    observer.observe([run()]);
    expect(events.filter((event) => event.type === "item.started")).toHaveLength(1);
    observer.observe([
      { ...run(), children: [{ id: "tests", kind: "step", label: "Tests", state: "failed" }] },
    ]);
    observer.observe([]);
    expect(
      observer.project("subagent", launch, itemId)?.subagents.map((child) => child.status),
    ).toEqual(["running", "failed"]);
  });

  it("keeps a single worker's identity when its internal step becomes visible", () => {
    const observer = new PiSubagents(() => undefined);
    observer.observe([{ id: "run-1", kind: "subagent", label: "Worker", state: "running" }]);
    const initial = observer.project("subagent", launch, itemId)?.subagents;
    observer.observe([
      {
        id: "run-1",
        kind: "subagent",
        label: "Worker",
        state: "running",
        children: [{ id: "step:0", kind: "step", label: "Worker", state: "running" }],
      },
    ]);
    expect(observer.project("subagent", launch, itemId)?.subagents).toEqual(initial);
    expect(initial).toHaveLength(1);
  });

  it("projects matching child identities from native parent history", () => {
    const observer = new PiSubagents(() => undefined);
    observer.observe([run("complete")]);
    const snapshot = mapPiSnapshot(
      {
        leafId: "result",
        entries: [
          {
            id: "user",
            parentId: null,
            type: "message",
            message: { role: "user", content: "review" },
          },
          {
            id: "assistant",
            parentId: "user",
            type: "message",
            message: {
              role: "assistant",
              stopReason: "toolUse",
              content: [
                {
                  type: "toolCall",
                  id: "call",
                  name: "subagent",
                  arguments: { workflowScript: "..." },
                },
              ],
            },
          },
          {
            id: "result",
            parentId: "assistant",
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "call",
              toolName: "subagent",
              isError: false,
              ...launch,
              content: [],
            },
          },
        ],
      },
      { sessionId: "parent", model: null },
      observer,
    );
    const delegation = snapshot.turns[0]?.items.find(
      ({ item }) => item.type === "subagentDelegation",
    );
    expect(delegation?.item).toMatchObject({
      subagents: [
        { nativeSubagentId: piSubagentId({ runId: "run-1", childId: "security" }) },
        { nativeSubagentId: piSubagentId({ runId: "run-1", childId: "tests" }) },
      ],
    });
  });

  it("validates inspection payloads, preserves truncation, and does not fabricate a finished running child", () => {
    const reply = {
      kind: "pi-subagents.inspect-reply",
      version: 1,
      requestId: "request",
      asyncId: "run-1",
      status: "running",
      messages: [{ role: "assistant", kind: "text", text: "working" }],
      truncated: { task: false, messages: 3, finalOutput: false },
    };
    const parsed = parsePiSubagentInspection(
      widget(reply, "subagent-inspect", "PI_SUBAGENT_INSPECT_JSON:"),
    );
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error("Expected reply");
    const snapshot = piSubagentSnapshot("parent", piSubagentId({ runId: "run-1" }), parsed);
    expect(snapshot.turns[0]?.nativeTurnRef.nativeSessionId).toBe("parent");
    expect(snapshot.turns[0]?.input).toEqual([]);
    expect(snapshot.turns[0]?.outcome.status).toBe("unknown");
    expect(JSON.stringify(snapshot)).toContain("truncated transcript window");
    expect(
      parsePiSubagentInspection(
        widget(
          { ...reply, messages: [{ text: 123 }] },
          "subagent-inspect",
          "PI_SUBAGENT_INSPECT_JSON:",
        ),
      ),
    ).toBeNull();
  });
});
