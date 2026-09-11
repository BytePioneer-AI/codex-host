import { describe, expect, it } from "vitest";
import {
  conventionalType,
  field,
  hasContent,
  missingInformation,
  planLabels,
  sections,
} from "../src/intake.mjs";
import { AREAS } from "../src/policy.mjs";
import { item } from "./fixtures.mjs";

describe("intake without model inference", () => {
  it.each([
    ["fix(thread): recover history", "bug"],
    ["feat!: add a Harness", "enhancement"],
    ["docs: explain Thread", "documentation"],
    ["ci: adjust matrix", "chore"],
    ["refactor: no behavior change", "chore"],
    ["fix the bug", null],
    ["feat: ", null],
  ])("classifies the conventional title %s", (title, result) => {
    expect(conventionalType(title)).toBe(result);
  });

  it("falls back to commits without letting chores outvote fixes, and leaves mixed types alone", () => {
    const input = { item: item({ title: "stack 2/3" }), isPr: true };
    expect(planLabels({ ...input, commits: ["test: regression", "fix: recover"] }).add).toEqual([
      "bug",
    ]);
    expect(planLabels({ ...input, commits: ["feat: add", "fix: recover"] }).add).toEqual([]);
  });

  it("syncs bot-owned PR labels but preserves human changes and removals", () => {
    const input = { item: item({ title: "feat: support", labels: [{ name: "bug" }] }), isPr: true };
    expect(planLabels(input)).toEqual({ add: ["enhancement"], remove: ["bug"] });
    for (const event of ["labeled", "unlabeled"]) {
      expect(
        planLabels({
          ...input,
          events: [{ event, label: { name: "bug" }, actor: { login: "maintainer" } }],
        }),
      ).toEqual({ add: [], remove: [] });
    }
  });

  it.each(Object.entries(AREAS))("maps Issue Area %s without title heuristics", (area, label) => {
    const issue = item({
      body: `### Area\n${area}\n### Reproduction\n1. Reopen`,
      labels: [{ name: "bug" }],
    });
    expect(planLabels({ item: issue, isPr: false }).add).toEqual([label]);
  });

  it("does not invent area labels for unstructured issues or unknown choices", () => {
    expect(
      planLabels({ item: item({ body: "### Area\nOther / Unknown" }), isPr: false }).add,
    ).toEqual([]);
    expect(
      planLabels({
        item: item({ title: "SSE bug provider install", body: "unstructured" }),
        isPr: false,
      }).add,
    ).toEqual([]);
  });

  it("does not overwrite human area labels", () => {
    const issue = item({
      body: "### Area\nDesktop / Renderer",
      labels: [{ name: "area:adapter" }],
    });
    const events = [
      { event: "unlabeled", label: { name: "area:desktop" }, actor: { login: "maintainer" } },
    ];
    expect(planLabels({ item: issue, isPr: false, events }).add).toEqual([]);
  });

  it("ignores hidden guidance and fake headings inside code fences", () => {
    const text =
      "<!-- ## Summary\nnot evidence -->\n## Summary\n```md\n## Test plan\nnot a field\n```\n";
    expect(sections(text).has("test plan")).toBe(false);
    expect(field(text, "tests")).toBe("");
    expect(hasContent("<!-- provide results -->")).toBe(false);
    expect(hasContent("_No response_")).toBe(false);
    expect(hasContent("N/A — documentation only")).toBe(true);
    expect(hasContent("未知")).toBe(true);
  });

  it("supports translated headings without requiring AI translation", () => {
    expect(field("## 测试与验证\n定向测试通过", "tests")).toBe("定向测试通过");
  });

  it("only suggests missing data and permits useful free-form reports", () => {
    const freeform = item({ body: "I cannot restore my previous Thread; here is what happens..." });
    expect(missingInformation(freeform, false)).toEqual([]);
    expect(missingInformation(item({ body: "" }), true)).toEqual([
      "Summary",
      "Related issues",
      "Test plan",
    ]);
    expect(
      missingInformation(item({ labels: [{ name: "bug" }], body: "### Summary\nCrash" }), false),
    ).toContain("Reproduction");
  });
});
