import { describe, expect, it } from "vitest";

import {
  GROK_SESSION_FORK_METHOD,
  buildGrokForkParams,
  isGrokMethodNotFound,
  parseGrokForkResponse,
} from "../src/grok-fork.js";

describe("Grok Fork ACP envelope", () => {
  it("uses the underscore-prefixed wire method and camelCase params", () => {
    expect(GROK_SESSION_FORK_METHOD).toBe("_x.ai/session/fork");
    expect(
      buildGrokForkParams({
        sourceSessionId: "parent",
        sourceCwd: "/src",
        newCwd: "/src",
        targetPromptIndex: 0,
        sessionKind: "fork",
      }),
    ).toEqual({
      sourceSessionId: "parent",
      sourceCwd: "/src",
      newCwd: "/src",
      targetPromptIndex: 0,
      sessionKind: "fork",
    });
  });

  it("omits optional fields and still sends targetPromptIndex 0", () => {
    expect(
      buildGrokForkParams({
        sourceSessionId: "parent",
        sourceCwd: "/src",
        newCwd: "/dst",
        targetPromptIndex: 0,
      }),
    ).toEqual({
      sourceSessionId: "parent",
      sourceCwd: "/src",
      newCwd: "/dst",
      targetPromptIndex: 0,
    });
  });

  it("parses a top-level response and a result-wrapped response", () => {
    expect(
      parseGrokForkResponse({
        newSessionId: "child",
        parentSessionId: "parent",
        chatMessagesCopied: 2,
      }),
    ).toMatchObject({ newSessionId: "child", parentSessionId: "parent" });
    expect(parseGrokForkResponse({ result: { newSessionId: "child" } })).toEqual({
      newSessionId: "child",
    });
  });

  it("rejects a missing Session identity, an error payload, and Method Not Found", () => {
    expect(parseGrokForkResponse({})).toBeNull();
    expect(parseGrokForkResponse({ result: {} })).toBeNull();
    expect(parseGrokForkResponse({ newSessionId: "child", error: "nope" })).toBeNull();
    expect(isGrokMethodNotFound({ code: -32601, message: "Method not found" })).toBe(true);
    expect(isGrokMethodNotFound(new Error("Grok ACP Method Not Found: _x.ai/session/fork"))).toBe(
      true,
    );
    expect(isGrokMethodNotFound(new Error("native timeout"))).toBe(false);
  });
});
