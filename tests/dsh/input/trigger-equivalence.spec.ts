import { describe, expect, it } from "vitest";
import { detectTrigger } from "@deepseek-ai/dsh-client-ui-input-trigger/src/core/detect.ts";

describe("equivalent reference menu triggers", () => {
  for (const tier of ["plain", "claimed", "frozen"] as const) {
    for (const query of [
      "",
      "123.ts",
      "src/config.ts",
      '"my docs/read me',
      '"my @file',
      '"my #file',
      "a".repeat(80),
    ]) {
      it(`${tier}: ${query}`, () => {
        const at = `Read @${query}`;
        const hash = `Read #${query}`;
        const expected = detectTrigger(at, at.length, { tier });
        expect(detectTrigger(hash, hash.length, { tier })).toEqual(
          expected ? { ...expected, trigger: "#" } : null,
        );
      });
    }
  }
  for (const text of [
    "https://site/#x",
    "https://site/#/compact",
    "https://site/@/compact",
    "word#file",
    "\\#file",
    "# ",
    "@ ",
  ]) {
    it(`does not claim ${text}`, () => {
      expect(detectTrigger(text, text.length, { tier: "plain" })).toBeNull();
    });
  }
});
