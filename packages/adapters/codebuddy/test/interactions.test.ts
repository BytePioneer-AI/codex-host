import { describe, expect, it } from "vitest";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CodeBuddyInteractions } from "../src/interactions.js";

describe("CodeBuddy / WorkBuddy ACP approvals", () => {
  it.each(["Bash", "Read"])(
    "projects %s always approval as session-scoped without changing the native option",
    async (toolName) => {
      const outputs: HarnessOutput[] = [];
      const interactions = new CodeBuddyInteractions(
        (output) => outputs.push(output),
        () => {
          throw new Error("Ordinary approval must not call the question extension");
        },
      );
      const turnId = hostTurnIdSchema.parse("approval-turn");
      const response = interactions.permission(turnId, {
        sessionId: "native-session",
        toolCall: {
          toolCallId: "native-call",
          _meta: { "codebuddy.ai/toolName": toolName },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "allow_always", name: "Always Allow", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      const output = outputs[0];
      if (output?.kind !== "interaction" || output.interaction.type !== "approval")
        throw new Error("Expected approval");
      expect(output.interaction).toMatchObject({
        title: toolName,
        actions: [
          { id: "allow", effect: "allowOnce" },
          { id: "allow_always", effect: "allowForSession" },
          { id: "reject", effect: "deny" },
        ],
      });
      expect(
        await interactions.respond({
          type: "interaction.respond",
          interactionId: output.interaction.interactionId,
          response: { type: "approval", actionId: "allow_always" },
        }),
      ).toEqual({ ok: true, value: { accepted: true } });
      expect(await response).toEqual({
        outcome: { outcome: "selected", optionId: "allow_always" },
      });
      expect(outputs.at(-1)).toMatchObject({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: output.interaction.interactionId,
          reason: "responded",
        },
      });
      interactions.close();
    },
  );
});
