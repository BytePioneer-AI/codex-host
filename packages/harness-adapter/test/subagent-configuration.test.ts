import { expect, it } from "vitest";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import {
  configureSubagentEvent,
  inheritSubagentConfiguration,
  subagentConfiguration,
} from "../src/subagent-configuration.js";
import type { HostSubagentDelegationItem } from "../src/text-session.js";

it("never coerces unknown native configuration, and handles inherit explicitly", () => {
  expect(subagentConfiguration({ model: {}, thinking: 4 })).toEqual({});
  expect(subagentConfiguration({ model: "inherit", reasoning_effort: "high" })).toEqual({
    reasoningEffort: "high",
  });
  expect(subagentConfiguration({ model: "native", thinking: "off" })).toEqual({
    model: "native",
    reasoningEffort: "off",
  });
});
it("fills only absent values, without mutating the child", () => {
  const child = {
    subagentId: "child",
    description: "Task",
    status: "running" as const,
    background: false,
  };
  expect(
    inheritSubagentConfiguration(child, { model: "parent", reasoningEffort: "high" }),
  ).toMatchObject({ model: "parent", reasoningEffort: "high" });
  expect(inheritSubagentConfiguration(child, {})).toEqual(child);
});
it("normalizes replacements and completions without touching statuses, IDs or original items", () => {
  const item: HostSubagentDelegationItem = {
    type: "subagentDelegation",
    itemId: hostItemIdSchema.parse("call"),
    operation: "spawn",
    subagents: [{ subagentId: "child", description: "Task", status: "failed", background: false }],
  };
  const turnId = hostTurnIdSchema.parse("turn");
  const parent = { model: "parent", reasoningEffort: "high" };
  expect(
    configureSubagentEvent(
      {
        type: "item.updated",
        turnId,
        itemId: item.itemId,
        update: { type: "subagents.replace", subagents: item.subagents },
      },
      parent,
    ),
  ).toMatchObject({
    update: { subagents: [{ ...parent, status: "failed", subagentId: "child" }] },
  });
  expect(
    configureSubagentEvent(
      { type: "item.completed", turnId, snapshot: { item, outcome: { status: "succeeded" } } },
      parent,
    ),
  ).toMatchObject({ snapshot: { item: { subagents: [{ ...parent, status: "failed" }] } } });
  expect(item.subagents[0]).not.toHaveProperty("model");
});

it("treats a native inherit selector as an absent child model, including without a known parent", () => {
  const child = {
    subagentId: "child",
    description: "Task",
    status: "running" as const,
    background: false,
    model: "inherit",
  };
  expect(inheritSubagentConfiguration(child, { model: "parent" })).toMatchObject({
    model: "parent",
  });
  expect(inheritSubagentConfiguration(child, {})).not.toHaveProperty("model");
});
