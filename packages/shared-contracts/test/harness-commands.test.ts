import { describe, expect, it } from "vitest";

import {
  harnessCommandDescriptorSchema,
  threadCommandExecuteParamsSchema,
  threadCommandExecuteResultSchema,
} from "@codexhost/shared-contracts";

describe("Harness Command runtime contracts", () => {
  it("round-trips strict text command input", () => {
    const params = {
      threadId: "thread-1",
      commandId: "dsh.goal",
      arguments: { text: "ship it" },
    };

    expect(threadCommandExecuteParamsSchema.parse(params)).toEqual(params);
    expect(JSON.parse(JSON.stringify(threadCommandExecuteParamsSchema.parse(params)))).toEqual(
      params,
    );
    expect(
      harnessCommandDescriptorSchema.parse({
        id: "dsh.goal",
        invocation: "/dsh-goal",
        label: "Goal",
        argumentMode: "text",
      }),
    ).toEqual({
      id: "dsh.goal",
      invocation: "/dsh-goal",
      label: "Goal",
      argumentMode: "text",
    });
  });

  it("rejects command image fields and capability declarations", () => {
    expect(
      threadCommandExecuteParamsSchema.safeParse({
        threadId: "thread-1",
        commandId: "dsh.goal",
        images: [{ type: "image", url: "data:image/png;base64,AA==" }],
      }).success,
    ).toBe(false);
    expect(
      harnessCommandDescriptorSchema.safeParse({
        id: "dsh.goal",
        invocation: "/dsh-goal",
        label: "Goal",
        argumentMode: "text",
        acceptsImages: true,
      }).success,
    ).toBe(false);
  });

  it("keeps completion promises out of the RPC result", () => {
    expect(
      threadCommandExecuteResultSchema.safeParse({
        accepted: true,
        turnId: "turn-1",
        completion: Promise.resolve({ status: "succeeded" }),
      }).success,
    ).toBe(false);
  });
});
