import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HostEvent } from "@codexhost/harness-adapter";
import { BackgroundCommands } from "../src/background.js";
import { LiveItems } from "../src/live-items.js";
import type { NativeCommandStatus } from "../src/commands.js";
import { projectPlanItem } from "../src/history.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/native-background-command.json", import.meta.url), "utf8"),
);
const turnId = hostTurnIdSchema.parse("host-parent");
const ref = { messageId: "native-user", planItemId: "native-plan", commandId: "native-command" };
const status = (state: "running" | "succeeded"): NativeCommandStatus => ({
  ...ref,
  status: state,
  output: state === "running" ? "" : "DONE\r\n",
  outputTruncated: false,
  ...(state === "succeeded" ? { exitCode: 0 } : {}),
});
const snapshot = (value: NativeCommandStatus) => ({
  sessionId: "session",
  items: [{ reply_to_message_id: ref.messageId, commandStatuses: [value] }],
});
afterEach(() => vi.useRealTimers());

describe("TRAE CN detached command observation", () => {
  it.each([
    { status: "skipped_run" },
    { status: "running" },
    { status: "success", data: { command_id: "", is_background: true } },
    { status: "success", data: { command_id: 42, is_background: true } },
  ])("rejects background receipts without a stable execution ID: %j", (result) => {
    const events: HostEvent[] = [],
      follow = vi.fn();
    const live = new LiveItems(turnId, (event) => events.push(event), { follow });
    const plan = structuredClone(fixture.plan);
    plan.tool_call_info.result = result;
    plan.confirm_info = { confirm_status: "skipped_run" };
    expect(() => live.acceptPlan(plan)).toThrowError(
      expect.objectContaining({ code: "unsupported" }),
    );
    expect(() => projectPlanItem(plan, { status: "succeeded" }, undefined, true)).toThrowError(
      expect.objectContaining({ code: "unsupported" }),
    );
    live.settle({ status: "succeeded" });
    expect(events).toEqual([]);
    expect(follow).not.toHaveBeenCalled();
    expect(live.snapshots).toEqual([]);
  });

  it("rejects a changed command identity on the same live Plan", () => {
    const live = new LiveItems(turnId, vi.fn(), { follow: vi.fn() });
    live.acceptPlan(fixture.plan);
    const changed = structuredClone(fixture.plan);
    changed.tool_call_info.result.data.command_id = "foreign";
    expect(() => live.acceptPlan(changed)).toThrowError(
      expect.objectContaining({ code: "protocolError" }),
    );
  });
  it("does not detach or follow a denied background launch that never got an execution identity", () => {
    const events: HostEvent[] = [],
      follow = vi.fn();
    const live = new LiveItems(turnId, (event) => events.push(event), { follow });
    const denied = structuredClone(fixture.plan);
    denied.tool_call_info.result = { status: "failed", data: { exit_code: 1, stdout: "denied" } };
    live.acceptPlan(denied);
    expect(follow).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "item.detached")).toBe(false);
    expect(live.snapshots).toMatchObject([{ outcome: { status: "failed" } }]);
  });
  it("settles the original command after its parent Turn without replaying the launch receipt", () => {
    const events: HostEvent[] = [];
    const background = new BackgroundCommands({
      snapshot: vi.fn(),
      sessionId: () => "session",
      fault: vi.fn(),
    });
    const live = new LiveItems(turnId, (event) => events.push(event), {
      follow: (owner, update) => background.follow(owner, turnId, update),
    });
    live.acceptPlan(fixture.plan);
    live.acceptPlan(fixture.plan);
    live.settle({ status: "succeeded" });
    expect(events.map((event) => event.type)).toEqual(["item.started", "item.detached"]);
    expect(live.snapshots).toEqual([]);
    background.observe(snapshot(status("succeeded")));
    live.acceptPlan(fixture.plan); // late parent replay must not overwrite observed output
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(1);
    expect(live.snapshots).toMatchObject([
      { item: { output: "DONE\r\n", exitCode: 0 }, outcome: { status: "succeeded" } },
    ]);
    expect(live.hasDetachedWork).toBe(false);
    expect(background.hasWork).toBe(false);
    background.close();
  });

  it("polls only after durable parent completion and stops after the real result", async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => snapshot(status("succeeded"))),
      update = vi.fn(),
      fault = vi.fn();
    const background = new BackgroundCommands({
      snapshot: poll,
      sessionId: () => "session",
      fault,
      intervalMs: 10,
    });
    background.follow(ref, turnId, update);
    await vi.advanceTimersByTimeAsync(50);
    expect(poll).not.toHaveBeenCalled();
    background.activate(turnId);
    await vi.advanceTimersByTimeAsync(50);
    expect(poll).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(fault).not.toHaveBeenCalled();
    expect(background.hasWork).toBe(false);
    background.close();
  });

  it("does not publish an in-flight read after observation closes", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<unknown>(),
      update = vi.fn(),
      fault = vi.fn();
    const background = new BackgroundCommands({
      snapshot: () => pending.promise,
      sessionId: () => "session",
      fault,
      intervalMs: 10,
    });
    background.follow(ref, turnId, update);
    background.activate(turnId);
    await vi.advanceTimersByTimeAsync(10);
    background.close();
    pending.resolve(snapshot(status("succeeded")));
    await vi.advanceTimersByTimeAsync(10);
    expect(update).not.toHaveBeenCalled();
    expect(fault).not.toHaveBeenCalled();
    expect(background.hasWork).toBe(false);
  });

  it.each([
    { sessionId: "foreign", items: [] },
    snapshot({ ...status("succeeded"), planItemId: "foreign" }),
    snapshot({ ...status("succeeded"), outputTruncated: true }),
    { sessionId: "session", items: [] },
  ])("faults on missing, foreign or truncated execution facts", async (value) => {
    vi.useFakeTimers();
    const update = vi.fn(),
      fault = vi.fn(),
      poll = vi.fn(async () => value);
    const background = new BackgroundCommands({
      snapshot: poll,
      sessionId: () => "session",
      fault,
      intervalMs: 10,
    });
    background.follow(ref, turnId, update);
    background.activate(turnId);
    await vi.advanceTimersByTimeAsync(50);
    expect(fault).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledOnce();
    expect(background.hasWork).toBe(false);
  });
});
