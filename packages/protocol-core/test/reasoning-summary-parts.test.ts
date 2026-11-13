import { describe, expect, it } from "vitest";
import type { HostThreadSnapshot } from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeTurnRefSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";

import { CodexTurnProjector, projectHistoricalTurn } from "../src/index.js";
import { reasoningSummaryParts } from "../src/reasoning-summary-parts.js";

const turnId = hostTurnIdSchema.parse("turn-1");
const reasoningId = hostItemIdSchema.parse("reasoning-1");
const previewId = `${reasoningId}-summary`;

const samples = [
  "Reading the config. It has two keys.\n\nWhat next? Check the **schema**.\n\n**Plan**\n\nUpdate it.",
  "First line\nsecond line.\r\n \r\nAnother paragraph without an ending",
  "**Inspecting files**\n\nLooking at the projector.\n\n\n**Next**\n\nWriting tests.\n\n",
  "我先检查配置。然后修改。\n\n第二段思考！继续",
  `${"word ".repeat(20)}tail. Done.\n\n${"x".repeat(70)}.\n\n*\n\n* bullet item`,
  "Plan:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n1. Check e.g. step 2. Then\n\n## Done",
  `${"中".repeat(31)}。\n\n**Title**\n\nBody.\n\nMore body.\n\n~~~\nx\n\n~~~`,
];

function startedProjector(): CodexTurnProjector {
  const value = new CodexTurnProjector({
    threadId: "thread-1",
    turnId,
    cwd: "/workspace",
    startedAtMs: 1_000,
  });
  value.project({ type: "turn.started", turnId });
  value.project({
    type: "item.started",
    turnId,
    item: { type: "reasoning", itemId: reasoningId, text: "" },
  });
  return value;
}

function append(value: CodexTurnProjector, text: string): JsonObject[] {
  return value.project({
    type: "item.updated",
    turnId,
    itemId: reasoningId,
    update: { type: "text.append", text },
  }).messages;
}

function complete(value: CodexTurnProjector, text: string): JsonObject[] {
  return value.project({
    type: "item.completed",
    turnId,
    snapshot: {
      item: { type: "reasoning", itemId: reasoningId, text },
      outcome: { status: "succeeded" },
    },
  }).messages;
}

function summaryMessages(messages: JsonObject[]): Record<string, unknown>[] {
  return messages
    .filter(({ method }) => typeof method === "string" && method.startsWith("item/reasoning/"))
    .map(({ method, params }) => {
      const { itemId, summaryIndex, delta } = params as JsonObject;
      expect(itemId).toBe(previewId);
      return delta === undefined ? { method, summaryIndex } : { method, summaryIndex, delta };
    });
}

function historicalSummary(text: string): unknown {
  const snapshot: HostThreadSnapshot["turns"][number] = {
    nativeTurnRef: nativeTurnRefSchema.parse({
      harnessId: "pi",
      nativeSessionId: "session-1",
      nativeTurnKey: "turn-1",
      formatVersion: 1,
    }),
    input: [],
    items: [
      {
        item: { type: "reasoning", itemId: reasoningId, text },
        outcome: { status: "succeeded" },
      },
    ],
    outcome: { status: "succeeded" },
  };
  const items = projectHistoricalTurn({ turnId, cwd: "/workspace", snapshot })
    .items as JsonObject[];
  return items.find((item) => item.id === previewId)?.summary;
}

describe("Reasoning summary parts", () => {
  it("lifts an untitled paragraph's first sentence into a bold title", () => {
    expect(
      reasoningSummaryParts("Reading the config. It has two keys.\n\nWhat next? Check", true),
    ).toEqual(["**Reading the config**\n\nIt has two keys.", "**What next?**\n\nCheck"]);
    expect(reasoningSummaryParts("我先检查配置。然后修改。", true)).toEqual([
      "**我先检查配置**\n\n然后修改。",
    ]);
    expect(reasoningSummaryParts("First line\nsecond line.", true)).toEqual([
      "**First line**\n\nsecond line.",
    ]);
  });

  it("keeps native titled parts with every untitled paragraph that follows", () => {
    expect(
      reasoningSummaryParts(
        "**Inspecting**\n\nLooking.\n\nThen more.\n\n**Next** step now\n\nMore.",
        true,
      ),
    ).toEqual(["**Inspecting**\n\nLooking.\n\nThen more.", "**Next** step now\n\nMore."]);
  });

  it("keeps code fences whole and never titles a fence line", () => {
    const code = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
    expect(reasoningSummaryParts(`${code}\n\nAfter code.`, true)).toEqual([code, "**After code**"]);
    expect(reasoningSummaryParts(`Plan:\n\n${code}`, true)).toEqual([`**Plan:**\n\n${code}`]);
    expect(reasoningSummaryParts("Plan:\n\n``", false)).toEqual(["**Plan:**"]);
  });

  it("titles past list and heading markers and abbreviations", () => {
    expect(reasoningSummaryParts("1. Check the config\n2. Run tests", true)).toEqual([
      "**Check the config**\n\n2. Run tests",
    ]);
    expect(reasoningSummaryParts("## Plan\n\n- read a file", true)).toEqual([
      "**Plan**",
      "**read a file**",
    ]);
    expect(reasoningSummaryParts("Try e.g. step 2 first. Then go.", true)).toEqual([
      "**Try e.g. step 2 first**\n\nThen go.",
    ]);
  });

  it("caps a long first sentence and keeps the whole paragraph as its body", () => {
    const paragraph = `${"word ".repeat(20)}tail. Done.`;
    expect(reasoningSummaryParts(paragraph, true)).toEqual([
      `**${"word ".repeat(12).trim()}…**\n\n${paragraph}`,
    ]);
    expect(reasoningSummaryParts("x".repeat(70), true)).toEqual([
      `**${"x".repeat(60)}…**\n\n${"x".repeat(70)}`,
    ]);
    // Wide characters count two columns against the cap.
    expect(reasoningSummaryParts(`${"中".repeat(30)}。`, true)).toEqual([`**${"中".repeat(30)}**`]);
    expect(reasoningSummaryParts(`${"中".repeat(31)}。`, true)).toEqual([
      `**${"中".repeat(30)}…**\n\n${"中".repeat(31)}。`,
    ]);
  });

  it("holds an open paragraph until its title is decided", () => {
    expect(reasoningSummaryParts("Reading the con", false)).toEqual([]);
    expect(reasoningSummaryParts("Reading.", false)).toEqual([]);
    expect(reasoningSummaryParts("*", false)).toEqual([]);
    expect(reasoningSummaryParts("1.", false)).toEqual([]);
    expect(reasoningSummaryParts(`${"中".repeat(30)}`, false)).toEqual([]);
    expect(reasoningSummaryParts("Reading. N", false)).toEqual(["**Reading**\n\nN"]);
    expect(reasoningSummaryParts("Reading.", true)).toEqual(["**Reading**"]);
    expect(reasoningSummaryParts("**Pla", false)).toEqual(["**Pla"]);
  });

  it("only grows parts as text is appended", () => {
    for (const text of samples) {
      const final = reasoningSummaryParts(text, true);
      for (let end = 0; end <= text.length; end += 1) {
        const parts = reasoningSummaryParts(text.slice(0, end), false);
        expect(parts.length).toBeLessThanOrEqual(final.length);
        parts.forEach((part, index) => expect(final[index]?.startsWith(part)).toBe(true));
      }
    }
  });
});

describe("Codex UI projector Reasoning summary parts", () => {
  it("starts a summary part at each paragraph boundary while streaming", () => {
    const value = startedProjector();
    const first = append(value, "Reading the config. It has");
    expect(first.map(({ method }) => method)).toEqual([
      "item/started",
      "item/started",
      "item/commandExecution/outputDelta",
      "item/reasoning/summaryPartAdded",
      "item/reasoning/summaryTextDelta",
    ]);
    expect(summaryMessages(first)).toEqual([
      { method: "item/reasoning/summaryPartAdded", summaryIndex: 0 },
      {
        method: "item/reasoning/summaryTextDelta",
        summaryIndex: 0,
        delta: "**Reading the config**\n\nIt has",
      },
    ]);
    expect(summaryMessages(append(value, " two keys.\n"))).toEqual([
      { method: "item/reasoning/summaryTextDelta", summaryIndex: 0, delta: " two keys." },
    ]);
    // The blank line is split across deltas; the new part opens once it is proven.
    expect(summaryMessages(append(value, "\nWhat next? Check"))).toEqual([
      { method: "item/reasoning/summaryPartAdded", summaryIndex: 1 },
      {
        method: "item/reasoning/summaryTextDelta",
        summaryIndex: 1,
        delta: "**What next?**\n\nCheck",
      },
    ]);
    expect(summaryMessages(append(value, " the **schema**.\n\n**Plan**\n\nUpdate it."))).toEqual([
      { method: "item/reasoning/summaryTextDelta", summaryIndex: 1, delta: " the **schema**." },
      { method: "item/reasoning/summaryPartAdded", summaryIndex: 2 },
      {
        method: "item/reasoning/summaryTextDelta",
        summaryIndex: 2,
        delta: "**Plan**\n\nUpdate it.",
      },
    ]);

    const text = samples[0] ?? "";
    const summary = [
      "**Reading the config**\n\nIt has two keys.",
      "**What next?**\n\nCheck the **schema**.",
      "**Plan**\n\nUpdate it.",
    ];
    const completed = complete(value, text);
    expect(summaryMessages(completed)).toEqual([]);
    expect(completed).toMatchObject([
      { method: "item/completed", params: { item: { id: previewId, summary } } },
      {
        method: "item/completed",
        params: { item: { id: reasoningId, command: "thinking", aggregatedOutput: text } },
      },
    ]);
    expect(historicalSummary(text)).toEqual(summary);
  });

  it("flushes a paragraph whose title was undecided when the Item completes", () => {
    const value = startedProjector();
    expect(summaryMessages(append(value, "Short note"))).toEqual([]);
    expect(summaryMessages(complete(value, "Short note"))).toEqual([
      { method: "item/reasoning/summaryPartAdded", summaryIndex: 0 },
      { method: "item/reasoning/summaryTextDelta", summaryIndex: 0, delta: "**Short note**" },
    ]);
  });

  it("streams the completed and historical parts for any delta split", () => {
    for (const text of samples) {
      const value = startedProjector();
      const streamed: string[] = [];
      const output: string[] = [];
      const record = (messages: JsonObject[]) => {
        for (const { method, params } of messages) {
          const { summaryIndex, delta } = params as { summaryIndex: number; delta: string };
          if (method === "item/reasoning/summaryPartAdded") {
            expect(summaryIndex).toBe(streamed.length);
            streamed.push("");
          } else if (method === "item/reasoning/summaryTextDelta") {
            streamed[summaryIndex] += delta;
          } else if (method === "item/commandExecution/outputDelta") {
            output.push(delta);
          }
        }
      };
      for (const character of text) record(append(value, character));
      const completed = complete(value, text);
      record(completed);
      const completedPreview = completed.find(({ method }) => method === "item/completed");
      const summary = (completedPreview?.params as { item: { summary: string[] } }).item.summary;
      expect(streamed).toEqual(summary);
      expect(historicalSummary(text)).toEqual(summary);
      expect(output.join("")).toBe(text.replace(/[\r\n]+$/u, ""));
    }
  });
});
