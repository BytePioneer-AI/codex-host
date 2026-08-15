import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertNoProtocolErrors,
  parseProtocolLine,
  runDifferential,
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

  it("creates and removes differential homes under an explicit safe parent", async () => {
    const parent = fs.mkdtempSync(path.join(os.homedir(), ".codexhost-gate-test-"));
    const fakeCodex = path.join(parent, "fake-codex.mjs");
    fs.writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("fake 1.0.0"); process.exit(0); }\nlet buffer = "";\nfor await (const chunk of process.stdin) {\n  buffer += chunk;\n  let newline;\n  while ((newline = buffer.indexOf("\\n")) >= 0) {\n    const line = buffer.slice(0, newline);\n    buffer = buffer.slice(newline + 1);\n    if (!line) continue;\n    const request = JSON.parse(line);\n    if (request.id === undefined) continue;\n    const result = request.method === "model/list" ? { data: [{ model: "fake", isDefault: true }] } : request.method === "thread/start" ? { thread: { id: "thread" } } : {};\n    console.log(JSON.stringify({ id: request.id, result }));\n  }\n}\n`,
      { mode: 0o755 },
    );
    try {
      const result = await runDifferential({
        stockCodexPath: process.execPath,
        stockCodexPrefixArguments: [fakeCodex],
        shimPath: process.execPath,
        shimPrefixArguments: [fakeCodex],
        temporaryParent: parent,
      });
      expect(result.unknownDifferences).toEqual([]);
      expect(fs.readdirSync(parent)).toEqual(["fake-codex.mjs"]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }, 15_000);
});
