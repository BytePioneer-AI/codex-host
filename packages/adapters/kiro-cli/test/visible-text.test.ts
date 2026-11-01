import { describe, expect, it } from "vitest";
import { KiroVisibleText, kiroVisibleText } from "../src/visible-text.js";
import { KiroTurnOutput } from "../src/turn-output.js";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { CodexTurnProjector } from "@codexhost/protocol-core";

const marker = "<\uff5cDSML\uff5cfunction_calls";

describe("Kiro leaked tool preambles", () => {
  it("handles every chunk split without changing surrounding text", () => {
    const input = `Inspecting tools.\n\n${marker}\n\n${marker}\nDone.`;
    const expected = "Inspecting tools.\n\n\n\n\nDone.";
    for (let split = 0; split <= input.length; split++) {
      const filter = new KiroVisibleText();
      expect(
        filter.push(input.slice(0, split)) + filter.push(input.slice(split)) + filter.finish(),
      ).toBe(expected);
    }
    const filter = new KiroVisibleText();
    expect([...input].map((character) => filter.push(character)).join("") + filter.finish()).toBe(
      expected,
    );
    expect(kiroVisibleText(`\n\n${marker}`)).toBe("\n\n");
  });

  it("preserves literal examples, complete markup and incomplete ordinary text", () => {
    for (const text of [
      `The marker is ${marker}`,
      `\`${marker}\``,
      `\`\`\`text\n${marker}\n\`\`\``,
      `~~~text\n${marker}\n~~~`,
      `${marker}>`,
      `${marker} is documented here`,
      "<",
      "<DSML",
      "x < y",
      " \n",
    ])
      expect(kiroVisibleText(text)).toBe(text);
  });

  it.each(["succeeded", "cancelled"] as const)(
    "keeps tool events and creates no empty messages on %s",
    (status) => {
      const turnId = hostTurnIdSchema.parse("dsml-turn");
      const outputs: HarnessOutput[] = [];
      const turn = new KiroTurnOutput(turnId, "/workspace", (output) => outputs.push(output));
      for (const character of `\n\n${marker}`)
        turn.accept({ type: "agent.text", text: character, messageId: "preamble" });
      turn.accept({
        type: "tool.call",
        callId: "read",
        title: "Read",
        name: "read_file",
        status: "in_progress",
      });
      turn.accept({ type: "tool.update", callId: "read", status: "completed", rawOutput: marker });
      turn.accept({ type: "agent.text", text: "Actual answer", messageId: "answer" });
      turn.finish({ status });
      const events = outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
      expect(
        events.filter((event) => event.type === "item.started").map((event) => event.item.type),
      ).toEqual(["toolExecution", "agentMessage"]);
      const projector = new CodexTurnProjector({
        threadId: "thread",
        turnId,
        cwd: "/workspace",
        startedAtMs: 0,
      });
      projector.project({ type: "turn.started", turnId });
      for (const event of events) {
        if ("turnId" in event && event.type !== "turn.autonomous.started") projector.project(event);
      }
      expect(() =>
        projector.project({ type: "turn.completed", turnId, outcome: { status } }),
      ).not.toThrow();
      expect(
        events.find(
          (event) =>
            event.type === "item.completed" && event.snapshot.item.type === "toolExecution",
        ),
      ).toMatchObject({
        snapshot: { item: { output: { content: [{ text: marker }] } } },
      });
      expect(events.findLast((event) => event.type === "item.completed")).toMatchObject({
        snapshot: {
          item: {
            text: "Actual answer",
            phase: status === "succeeded" ? "final_answer" : "commentary",
          },
        },
      });
    },
  );
});
