import { describe, expect, it } from "vitest";

import { ClaudeBackgroundOccupancy } from "../src/background-occupancy.js";

describe("ClaudeBackgroundOccupancy", () => {
  it("occupies a background spawn by callId until an agentId is bound", () => {
    const occupancy = new ClaudeBackgroundOccupancy();
    occupancy.occupySpawn("call-1");
    expect(occupancy.unsettled).toBe(true);
    occupancy.bind("call-1", "agent-1");
    occupancy.notify(undefined, "agent-1");
    expect(occupancy.awaitingContinuation).toBe(true);
    occupancy.releaseContinuations();
    expect(occupancy.unsettled).toBe(false);
  });

  it("keeps a notified Subagent occupied until its continuation is settled", () => {
    const occupancy = new ClaudeBackgroundOccupancy();
    occupancy.occupySpawn("call-1", "agent-1");
    occupancy.notify("call-1", "agent-1");
    expect(occupancy.unsettled).toBe(true);
    expect(occupancy.awaitingContinuation).toBe(true);
    occupancy.releaseContinuations();
    expect(occupancy.unsettled).toBe(false);
  });

  it("settles a notified Subagent addressed by either callId or agentId", () => {
    const occupancy = new ClaudeBackgroundOccupancy();
    occupancy.occupySpawn("call-1");
    occupancy.bind("call-1", "agent-1");
    occupancy.notify("call-1");
    expect(occupancy.awaitingContinuation).toBe(true);
    occupancy.releaseContinuations();
    expect(occupancy.unsettled).toBe(false);
  });

  it("keeps other background spawns occupied after one Subagent is notified", () => {
    const occupancy = new ClaudeBackgroundOccupancy();
    occupancy.occupySpawn("call-1");
    occupancy.occupySpawn("call-2");
    occupancy.occupySpawn("call-3");
    occupancy.bind("call-1", "agent-1");
    occupancy.bind("call-2", "agent-2");
    occupancy.bind("call-3", "agent-3");
    occupancy.notify(undefined, "agent-1");
    occupancy.releaseContinuations();
    expect(occupancy.unsettled).toBe(true);
    occupancy.notify("call-2", "agent-2");
    occupancy.notify(undefined, "agent-3");
    occupancy.releaseContinuations();
    expect(occupancy.unsettled).toBe(false);
  });

  it("owes a continuation for a tracked Subagent missing from the live level", () => {
    const occupancy = new ClaudeBackgroundOccupancy();
    occupancy.occupySpawn("call-1", "agent-1");
    occupancy.occupySpawn("call-2", "agent-2");
    occupancy.observeLive(["agent-2"]);
    expect(occupancy.awaitingContinuation).toBe(true);
    occupancy.releaseContinuations();
    expect(occupancy.unsettled).toBe(true);
    occupancy.observeLive([]);
    occupancy.releaseContinuations();
    expect(occupancy.unsettled).toBe(false);
  });

  it("ignores live levels that do not name a tracked Subagent", () => {
    const occupancy = new ClaudeBackgroundOccupancy();
    occupancy.occupySpawn("call-1");
    occupancy.observeLive(["unrelated-agent"]);
    expect(occupancy.awaitingContinuation).toBe(false);
    expect(occupancy.unsettled).toBe(true);
  });

  it("keeps a resumed Agent running after SendMessage", () => {
    const occupancy = new ClaudeBackgroundOccupancy();
    occupancy.occupySpawn("call-1", "agent-1");
    occupancy.notify("call-1", "agent-1");
    occupancy.occupyAgent("agent-1");
    expect(occupancy.awaitingContinuation).toBe(false);
    occupancy.releaseContinuations();
    expect(occupancy.unsettled).toBe(true);
  });

  it("does not treat a foreground complete as occupancy", () => {
    const occupancy = new ClaudeBackgroundOccupancy();
    occupancy.release("call-fg", "agent-fg");
    expect(occupancy.unsettled).toBe(false);
  });

  it("reports every occupied native Subagent when interrupted", () => {
    const occupancy = new ClaudeBackgroundOccupancy();
    occupancy.occupySpawn("call-1", "agent-1");
    occupancy.occupyAgent("agent-2");
    occupancy.notify(undefined, "agent-2");
    expect(occupancy.interruptAll().sort()).toEqual(["agent-1", "agent-2"]);
    expect(occupancy.unsettled).toBe(false);
  });
});
