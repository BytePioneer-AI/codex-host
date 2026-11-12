import { describe, expect, it } from "vitest";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { UserSubmissions } from "../src/user-submissions.js";

const turn = hostTurnIdSchema.parse("turn");
const other = hostTurnIdSchema.parse("other");

describe("user submission receipts", () => {
  it("settles only submissions bound to the actual execution, including native steer", () => {
    const receipts = new UserSubmissions();
    receipts.accept("first", turn, "first input");
    receipts.started(turn, false);
    receipts.accept("steer", turn, "steered input");
    receipts.started(turn, false);
    receipts.accept("queued", other, "queued input");
    receipts.finish(turn, "completed");
    expect(
      receipts.snapshot().map(({ clientUserMessageId, status }) => [clientUserMessageId, status]),
    ).toEqual([
      ["first", "completed"],
      ["steer", "completed"],
      ["queued", "accepted"],
    ]);
    expect(receipts.input(turn, "steer")).toBe("steered input");
    expect(receipts.input(other, "first")).toBeUndefined();
  });

  it("retains fast operation outcomes without a user-message echo and bounds completed receipts", () => {
    const receipts = new UserSubmissions();
    for (let n = 0; n < 300; n++) {
      const id = hostTurnIdSchema.parse(`op-${n}`);
      receipts.accept(`message-${n}`, id);
      receipts.started(id, true);
      receipts.operation(id, "compact", { id, status: "completed", items: [] });
      receipts.finish(id, "completed");
    }
    expect(receipts.snapshot()).toHaveLength(256);
    expect(receipts.snapshot().at(-1)).toMatchObject({
      clientUserMessageId: "message-299",
      status: "completed",
      execution: "operation",
      operation: { name: "compact" },
    });
  });
});
