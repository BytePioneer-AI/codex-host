import { describe, expect, it } from "vitest";
import { conventionalType, planLabels } from "../src/intake.mjs";
import { bot, human, item } from "./fixtures.mjs";

const event = (name, actor = bot, action = "labeled") => ({
  event: action,
  label: { name },
  actor,
});

describe("explicit PR title labels only", () => {
  it.each([
    ["fix: 修复会话恢复", "bug"],
    ["feat: 增加某个 Harness", "enhancement"],
    ["docs: 更新安装说明", "documentation"],
    ["fix(thread)!: recover", "bug"],
    ["调整会话处理", null],
    ["fix the bug", null],
    ["chore: update", null],
    ["perf: improve", null],
    ["test: coverage", null],
    ["refactor: cleanup", null],
    ["[Feature] Side Chat", null],
    ["fix:\nnot a title", null],
    ["feat: ", null],
  ])("classifies %s without inference", (title, result) => {
    expect(conventionalType(title)).toBe(result);
  });
  it("ignores body, commits and old Issue template evidence", () => {
    expect(
      planLabels({
        item: item({ title: "调整会话处理", body: "## Reproduction\nCrash" }),
        events: [],
        commits: ["fix: error"],
      }),
    ).toEqual({ add: [], remove: [] });
  });
  it("updates only bot-owned type labels", () => {
    const input = {
      item: item({ title: "feat: add", labels: [{ name: "bug" }, { name: "area:desktop" }] }),
      events: [event("bug")],
    };
    expect(planLabels(input)).toEqual({ add: ["enhancement"], remove: ["bug"] });
    expect(planLabels({ ...input, events: [] })).toEqual({ add: [], remove: [] });
    for (const action of ["labeled", "unlabeled"])
      expect(planLabels({ ...input, events: [event("bug", human, action)] })).toEqual({
        add: [],
        remove: [],
      });
  });
  it("does not change any labels if the new title is ambiguous", () => {
    expect(
      planLabels({
        item: item({ title: "更新逻辑", labels: [{ name: "bug" }] }),
        events: [event("bug")],
      }),
    ).toEqual({ add: [], remove: [] });
  });
});
