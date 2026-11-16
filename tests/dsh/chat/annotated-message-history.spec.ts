import { describe, expect, it } from "vitest";
import {
  composeAnnotatedMessage,
  parseAnnotatedMessage,
  responseAnnotationsOf,
} from "../../../packages/shared-contracts/src/response-annotation.ts";
import { responseAnnotationsOf as injected } from "../../../packages/shared-contracts/src/index.ts";

/**
 * A sent message is one recorded text: the bubble's body and its annotation
 * chips both come back from that text alone, so a reloaded transcript shows
 * the same row the send left behind.
 */
describe("a recorded annotated message", () => {
  const text = composeAnnotatedMessage(
    [{ text: "keep the drain loop" }, { text: "drop the retry", annotation: "why?" }],
    "Explain both.",
  );

  it("shows only the request body in the bubble", () => {
    expect(parseAnnotatedMessage(text).body).toBe("Explain both.");
  });

  it("derives the chips from the same recorded text", () => {
    expect(responseAnnotationsOf(text)).toEqual([
      { text: "keep the drain loop" },
      { text: "drop the retry", annotation: "why?" },
    ]);
  });

  it("is the same derivation the chat package imports", () => {
    expect(injected(text)).toEqual(responseAnnotationsOf(text));
  });

  it("leaves an ordinary message with no chips and its own body", () => {
    expect(parseAnnotatedMessage("just a message")).toEqual({
      annotations: [],
      body: "just a message",
    });
    expect(responseAnnotationsOf("just a message")).toEqual([]);
  });
});
