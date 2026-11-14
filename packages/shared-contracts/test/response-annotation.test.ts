import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RESPONSE_ANNOTATIONS_CLOSE,
  RESPONSE_ANNOTATIONS_HEADER,
  RESPONSE_ANNOTATIONS_OPEN,
  composeAnnotatedMessage,
  formatResponseAnnotations,
  parseAnnotatedMessage,
  responseAnnotationIndex,
  responseAnnotationsOf,
} from "../src/index.js";

/**
 * Prompts Codex Desktop composes for the same annotations and body, captured
 * by running the installed app's own assembly (`H`/`F`) and recorded here as
 * the expectation. A change to this contract must fail against these bytes.
 */
const GOLDEN = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/desktop-annotations.json"), "utf8"),
) as {
  readonly cases: readonly {
    readonly name: string;
    readonly annotations: readonly { readonly text: string; readonly annotation?: string }[];
    readonly body: string;
    readonly desktop: string;
  }[];
};

describe("response annotation block", () => {
  it.each(GOLDEN.cases)(
    "composes exactly the Desktop prompt for $name",
    ({ annotations, body, desktop }) => {
      expect(composeAnnotatedMessage(annotations, body)).toBe(desktop);
    },
  );

  it("emits nothing without annotations", () => {
    expect(formatResponseAnnotations([])).toBe("");
    expect(composeAnnotatedMessage([], "hello")).toBe("hello");
  });

  it("keeps a user comment only when one exists", () => {
    expect(
      formatResponseAnnotations([
        { text: "first", annotation: "tighten this" },
        { text: "second" },
      ]),
    ).toContain(
      `${RESPONSE_ANNOTATIONS_OPEN}\n[{"text":"first","annotation":"tighten this"},{"text":"second"}]\n${RESPONSE_ANNOTATIONS_CLOSE}`,
    );
  });
});

describe("parsing a logged message", () => {
  it.each(GOLDEN.cases)("splits its own output back apart for $name", ({ annotations, body }) => {
    const text = composeAnnotatedMessage(annotations, body);
    expect(parseAnnotatedMessage(text)).toEqual({ annotations, body: body.trim() });
  });

  it.each([
    ["before\n## My request:\nafter", "after"],
    ["before\n## My request for Codex:\nafter", "after"],
    ["before ## My request: after", "after"],
    ["context\n## My request:", ""],
    ["## My request:\nafter", "after"],
    ["## My request:\nfirst\n## My request:\nsecond", "second"],
  ])("reads the body of %j the way Desktop does", (text, body) => {
    expect(parseAnnotatedMessage(text).body).toBe(body);
  });

  it("leaves an ordinary message untouched", () => {
    expect(parseAnnotatedMessage("just a message")).toEqual({
      annotations: [],
      body: "just a message",
    });
  });

  it("reads annotations without splitting the body", () => {
    const text = composeAnnotatedMessage(
      [{ text: "a", annotation: "note" }, { text: "b" }],
      "body",
    );
    expect(responseAnnotationsOf(text)).toEqual([{ text: "a", annotation: "note" }, { text: "b" }]);
  });

  it("rejects a malformed block as a whole instead of renumbering it", () => {
    for (const json of [
      "{ not json",
      '[{"text":"first"},{"text":""}]',
      '[{"annotation":"only a comment"},{"text":"second"}]',
      '[{"text":"first"},{"text":"second","annotation":""}]',
      "[]",
    ]) {
      const text = `\n${RESPONSE_ANNOTATIONS_HEADER}\n${RESPONSE_ANNOTATIONS_OPEN}\n${json}\n${RESPONSE_ANNOTATIONS_CLOSE}\n\n## My request:\nbody\n`;
      expect(parseAnnotatedMessage(text)).toEqual({ annotations: [], body: "body" });
    }
  });
});

describe("inline citation", () => {
  it("accepts only the canonical positive integer Desktop accepts", () => {
    for (const index of ["1", "2", "12"])
      expect(responseAnnotationIndex(index)).toBe(Number(index));
    for (const index of ["01", "0", "-1", "1.0", " 1", "x", "", undefined])
      expect(responseAnnotationIndex(index)).toBeUndefined();
  });
});
