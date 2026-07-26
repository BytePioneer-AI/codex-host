import { describe, expect, it } from "vitest";

import {
  assertNoProtocolErrors,
  parseProtocolLine,
} from "../../tests/differential/codex-transparent-proxy.mjs";

describe("app-server stdout validation", () => {
  it("accepts a valid JSONL message", () => {
    expect(parseProtocolLine('{"id":1,"result":{}}', 1)).toEqual({
      message: { id: 1, result: {} },
    });
    expect(() => assertNoProtocolErrors("shim", [], 0)).not.toThrow();
  });

  it("fails on plain-text stdout", () => {
    const result = parseProtocolLine("codexhost shim started", 2);

    expect(result).toEqual({
      error: {
        lineNumber: 2,
        characterLength: 22,
        preview: "codexhost shim started",
        truncated: false,
      },
    });
    expect(() => assertNoProtocolErrors("shim", [result.error], 1)).toThrow(
      "shim app-server stdout contained 1 non-JSON line",
    );
  });

  it("fails on truncated JSON", () => {
    const result = parseProtocolLine('{"id":1', 3);

    expect(result).toEqual({
      error: {
        lineNumber: 3,
        characterLength: 7,
        preview: '{"id":1',
        truncated: false,
      },
    });
    expect(() => assertNoProtocolErrors("direct", [result.error], 1)).toThrow(
      "direct app-server stdout contained 1 non-JSON line",
    );
  });

  it("bounds diagnostics for an overlong invalid line", () => {
    const line = `${"x".repeat(500)}SENSITIVE_TAIL`;
    const result = parseProtocolLine(line, 4);

    expect(result.error).toMatchObject({
      lineNumber: 4,
      characterLength: line.length,
      truncated: true,
    });
    expect(result.error.preview).toHaveLength(160);
    expect(result.error.preview).not.toContain("SENSITIVE_TAIL");
  });
});
