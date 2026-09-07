import type { HostEvent, HostItemSnapshot } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as TranscriptModule from "../src/subagent-transcript.js";

import { AntigravitySubagents } from "../src/subagents.js";
import {
  parseSubagentTranscript,
  readSubagentTranscript,
  subagentRpc,
  subagentRunStatus,
} from "../src/subagent-transcript.js";

vi.mock("../src/subagent-transcript.js", async (original) => ({
  ...(await original<typeof TranscriptModule>()),
  subagentRpc: vi.fn(),
  readSubagentTranscript: vi.fn(),
}));

const parent = "448c75b2-603b-4bee-99a4-544288dfccad";
const child = "30dce1a0-bc56-4c5d-a50d-264f235f09a9";
const turnId = hostTurnIdSchema.parse("subagent-test");
const row = (value: object) => JSON.stringify(value) + "\n";
const transcript =
  row({
    step_index: 0,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    content:
      "<USER_REQUEST>\nInspect fixture\n</USER_REQUEST>\n<ADDITIONAL_METADATA>native metadata</ADDITIONAL_METADATA>",
  }) +
  row({
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    tool_calls: [{ name: "list_dir", args: { DirectoryPath: "fixture" } }],
  }) +
  row({ step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", content: "marker.txt" }) +
  row({
    step_index: 3,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    content: "AGY_CHILD_PROBE_OK",
  });
const native = (status: string, parentId = parent) => ({
  status: `CASCADE_RUN_STATUS_${status}`,
  trajectory: { metadata: { parentConversationId: parentId }, steps: [] },
});
const step = (state: string) => ({
  conversation_id: parent,
  step_index: 2,
  step_type: "subagent",
  state,
  tool_name: "invoke_subagent",
  subagent_info: {
    subagents: [
      {
        type_name: "research",
        role: "Probe Subagent",
        initial_prompt: "Inspect fixture",
        conversation_id: child,
        log_uri: "file:///not-a-trusted-path",
      },
    ],
  },
});

function fixture() {
  const events: HostEvent[] = [];
  const completed: HostItemSnapshot[] = [];
  const observer = new AntigravitySubagents({
    turnId,
    parentId: () => parent,
    port: async () => 1,
    cwd: process.cwd(),
    outputLimit: 64_000,
    emit: (event) => events.push(event),
    complete: (snapshot) => completed.push(snapshot),
    schedule: (work) => {
      void work();
    },
  });
  return { observer, events, completed };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("Antigravity Subagents", () => {
  it("projects captured transcript shapes with stable IDs, input, tools and final text", () => {
    const snapshot = parseSubagentTranscript(
      transcript,
      parent,
      child,
      "completed",
      process.cwd(),
      64_000,
    );
    expect(snapshot).toEqual(
      parseSubagentTranscript(transcript, parent, child, "completed", process.cwd(), 64_000),
    );
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.input).toEqual([{ type: "text", text: "Inspect fixture" }]);
    expect(snapshot.turns[0]?.items).toMatchObject([
      {
        item: {
          type: "toolExecution",
          toolName: "list_dir",
          output: { content: [{ text: "marker.txt" }] },
        },
      },
      { item: { type: "agentMessage", text: "AGY_CHILD_PROBE_OK" } },
    ]);
    expect(snapshot.turns[0]?.outcome).toEqual({ status: "succeeded" });
    const ids = snapshot.turns.flatMap((turn) => turn.items.map(({ item }) => item.itemId));
    expect(new Set(ids).size).toBe(ids.length);
    const otherParent = parseSubagentTranscript(
      transcript,
      child,
      child,
      "completed",
      process.cwd(),
      64_000,
    );
    expect(otherParent.turns[0]?.items[0]?.item.itemId).not.toBe(ids[0]);
  });

  it("ignores an incomplete final line, rejects interior corruption and does not invent terminal success", () => {
    const snapshot = parseSubagentTranscript(
      transcript + '{"step_index":4',
      parent,
      child,
      "running",
      process.cwd(),
      64_000,
    );
    expect(snapshot.turns[0]?.outcome.status).toBe("unknown");
    expect(snapshot.turns[0]?.items).toHaveLength(2);
    expect(() =>
      parseSubagentTranscript(
        "{broken}\n" + transcript,
        parent,
        child,
        "running",
        process.cwd(),
        64_000,
      ),
    ).toThrow();
    expect(() =>
      parseSubagentTranscript(
        transcript + transcript,
        parent,
        child,
        "running",
        process.cwd(),
        64_000,
      ),
    ).toThrow();
    expect(subagentRunStatus(native("IDLE", "foreign-parent"), parent)).toBeNull();
    expect(subagentRunStatus(native("RUNNING"), parent)).toBe("running");
    expect(subagentRunStatus(native("IDLE"), parent)).toBe("completed");
  });

  it("keeps a DONE spawn running until native idle and publishes progress separately", async () => {
    const { observer, events, completed } = fixture();
    vi.mocked(subagentRpc).mockResolvedValue(native("RUNNING"));
    vi.mocked(readSubagentTranscript).mockResolvedValue({
      ok: true,
      value: parseSubagentTranscript(transcript, parent, child, "running", process.cwd(), 64_000),
    });
    try {
      observer.handle(step("ACTIVE"));
      observer.handle(step("DONE"));
      observer.handle(step("DONE"));
      expect(completed).toHaveLength(1);
      expect(completed[0]?.item).toMatchObject({
        type: "subagentDelegation",
        subagents: [{ status: "running" }],
      });
      await observer.refresh();
      expect(observer.running).toBe(true);
      expect(events.some((event) => event.type === "subagent.transcript.changed")).toBe(true);
      vi.mocked(subagentRpc).mockResolvedValue(native("IDLE"));
      await observer.refresh();
      expect(observer.state(child)).toMatchObject({
        status: "completed",
        resultSummary: "AGY_CHILD_PROBE_OK",
      });
      observer.finish({ status: "succeeded" });
      await observer.settled;
      expect(events.filter((event) => event.type === "item.started")).toHaveLength(1);
      expect(events.filter((event) => event.type === "item.completed")).toHaveLength(1);
    } finally {
      observer.stop();
    }
  });

  it("keeps observation alive after parent completion and does not treat an RPC failure as child success", async () => {
    const { observer } = fixture();
    vi.mocked(subagentRpc).mockRejectedValue(new Error("transient"));
    vi.mocked(readSubagentTranscript).mockResolvedValue({
      ok: false,
      error: { code: "protocolError", message: "Not ready", retryable: true },
    });
    try {
      observer.handle(step("DONE"));
      observer.finish({ status: "succeeded" });
      let settled = false;
      void observer.settled.then(() => {
        settled = true;
      });
      await observer.refresh();
      expect(settled).toBe(false);
      expect(observer.running).toBe(true);
      vi.mocked(subagentRpc).mockResolvedValue(native("IDLE"));
      await observer.refresh();
      await observer.settled;
      expect(observer.running).toBe(false);
    } finally {
      observer.stop();
    }
  });

  it("validates ownership before cancelling and distinguishes unavailable native cancellation", async () => {
    const { observer, events } = fixture();
    observer.handle(step("ACTIVE"));
    vi.mocked(subagentRpc).mockResolvedValue(native("RUNNING"));
    await Promise.all([observer.cancel(), observer.cancel()]);
    observer.finish({ status: "cancelled" });
    expect(subagentRpc).toHaveBeenCalledWith(1, child, "CancelCascadeInvocation");
    expect(
      vi
        .mocked(subagentRpc)
        .mock.calls.filter((args) => args[1] === child && args[2] === "CancelCascadeInvocation"),
    ).toHaveLength(1);
    expect(observer.state(child)?.status).toBe("interrupted");
    expect(events.at(-1)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "cancelled" } },
    });
    const foreign = fixture();
    foreign.observer.handle(step("ACTIVE"));
    vi.mocked(subagentRpc).mockClear().mockResolvedValue(native("RUNNING", "other"));
    await foreign.observer.cancel();
    expect(subagentRpc).not.toHaveBeenCalledWith(1, child, "CancelCascadeInvocation");
    expect(foreign.observer.state(child)?.resultSummary).toContain("could not be confirmed");
  });

  it("observes a previously completed child in a later Turn without creating another card", async () => {
    const events: HostEvent[] = [];
    const observer = new AntigravitySubagents({
      turnId,
      parentId: () => parent,
      port: async () => 1,
      cwd: process.cwd(),
      outputLimit: 64_000,
      complete: () => undefined,
      emit: (event) => events.push(event),
      schedule: () => undefined,
      initialStates: [
        {
          subagentId: child,
          nativeSubagentId: child,
          description: "Existing",
          status: "interrupted",
          background: true,
        },
      ],
    });
    vi.mocked(readSubagentTranscript).mockResolvedValue({ ok: true, value: { turns: [] } });
    try {
      vi.mocked(subagentRpc).mockResolvedValue(native("IDLE"));
      await observer.refresh();
      expect(observer.state(child)?.status).toBe("interrupted");
      vi.mocked(subagentRpc).mockResolvedValue(native("RUNNING"));
      await observer.refresh();
      expect(observer.state(child)?.status).toBe("running");
      vi.mocked(subagentRpc).mockResolvedValue(native("IDLE"));
      await observer.refresh();
      expect(observer.state(child)?.status).toBe("completed");
      expect(events.some((event) => event.type === "item.started")).toBe(false);
    } finally {
      observer.stop();
    }
  });
});
