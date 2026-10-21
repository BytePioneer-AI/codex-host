import { describe, expect, it } from "vitest";
import { hostInteractionIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import {
  GROK_CLOCK_ELICIT_FIXTURE,
  GROK_CLOCK_ELICIT_PERSIST_FIXTURE,
  grokMcpElicitAccept,
  grokMcpElicitCancel,
  grokMcpElicitDecline,
  grokMcpElicitResponseForAction,
  parseGrokMcpElicitParams,
  projectGrokMcpElicitApproval,
} from "../src/grok-elicitation.js";

describe("Grok MCP elicitation parser", () => {
  it("accepts the sanitized Clock form and an empty object schema", () => {
    expect(parseGrokMcpElicitParams(GROK_CLOCK_ELICIT_FIXTURE)).toEqual({
      status: "form",
      request: GROK_CLOCK_ELICIT_FIXTURE,
    });
    expect(
      parseGrokMcpElicitParams({
        ...GROK_CLOCK_ELICIT_FIXTURE,
        requestedSchema: { type: "object", properties: {} },
      }),
    ).toMatchObject({ status: "form" });
  });

  it("cancels URL elicitation and unreviewed non-empty schemas without treating them as forms", () => {
    expect(
      parseGrokMcpElicitParams({
        sessionId: "s",
        toolCallId: "t",
        serverName: "cua_repl",
        message: "Open a URL",
        mode: "url",
        url: "https://example.invalid/consent",
        elicitationId: "e1",
      }),
    ).toEqual({ status: "unsupported" });
    expect(
      parseGrokMcpElicitParams({
        ...GROK_CLOCK_ELICIT_FIXTURE,
        requestedSchema: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
        },
      }),
    ).toEqual({ status: "unsupported" });
  });

  it("rejects malformed params and unreviewed top-level fields", () => {
    expect(parseGrokMcpElicitParams(null)).toMatchObject({ status: "invalid" });
    expect(parseGrokMcpElicitParams({ ...GROK_CLOCK_ELICIT_FIXTURE, mode: "other" })).toMatchObject(
      {
        status: "invalid",
      },
    );
    expect(
      parseGrokMcpElicitParams({ ...GROK_CLOCK_ELICIT_FIXTURE, persist: "always" }),
    ).toMatchObject({ status: "invalid" });
    expect(
      parseGrokMcpElicitParams({ ...GROK_CLOCK_ELICIT_FIXTURE, requestedSchema: "object" }),
    ).toMatchObject({ status: "invalid" });
  });

  it("projects allow-once/deny and maps Host actions to flat outcome replies", () => {
    const interaction = projectGrokMcpElicitApproval({
      interactionId: hostInteractionIdSchema.parse("interaction-1"),
      turnId: hostTurnIdSchema.parse("turn-1"),
      request: GROK_CLOCK_ELICIT_FIXTURE,
    });
    expect(interaction.actions.map(({ effect }) => effect)).toEqual(["allowOnce", "deny"]);
    expect(interaction.title).toContain("cua_repl");
    expect(grokMcpElicitResponseForAction("allowOnce")).toEqual(grokMcpElicitAccept());
    expect(grokMcpElicitResponseForAction("deny")).toEqual(grokMcpElicitDecline());
    expect(grokMcpElicitResponseForAction("cancel")).toEqual(grokMcpElicitCancel());
  });

  it("offers Always only when persist includes always and maps it to a scalar accept", () => {
    expect(parseGrokMcpElicitParams(GROK_CLOCK_ELICIT_PERSIST_FIXTURE)).toEqual({
      status: "form",
      request: { ...GROK_CLOCK_ELICIT_PERSIST_FIXTURE, persist: ["session", "always"] },
    });
    expect(
      parseGrokMcpElicitParams({ ...GROK_CLOCK_ELICIT_FIXTURE, persist: ["always", "session"] }),
    ).toMatchObject({
      status: "form",
      request: { persist: ["session", "always"] },
    });
    expect(
      parseGrokMcpElicitParams({ ...GROK_CLOCK_ELICIT_FIXTURE, persist: ["session"] }),
    ).toMatchObject({ status: "form", request: { persist: ["session"] } });
    const withAlways = projectGrokMcpElicitApproval({
      interactionId: hostInteractionIdSchema.parse("interaction-2"),
      turnId: hostTurnIdSchema.parse("turn-2"),
      request: GROK_CLOCK_ELICIT_PERSIST_FIXTURE,
    });
    expect(withAlways.actions.map(({ effect }) => effect)).toEqual([
      "allowOnce",
      "allowAlways",
      "deny",
    ]);
    const sessionOnly = projectGrokMcpElicitApproval({
      interactionId: hostInteractionIdSchema.parse("interaction-3"),
      turnId: hostTurnIdSchema.parse("turn-3"),
      request: { ...GROK_CLOCK_ELICIT_FIXTURE, persist: ["session"] },
    });
    expect(sessionOnly.actions.map(({ effect }) => effect)).toEqual(["allowOnce", "deny"]);
    expect(grokMcpElicitResponseForAction("allowAlways")).toEqual(grokMcpElicitAccept("always"));
  });
});
