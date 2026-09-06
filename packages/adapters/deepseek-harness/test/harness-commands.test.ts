import { describe, expect, it } from "vitest";

import { harnessCommandCatalogSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import {
  deepSeekHarnessCommandCatalog,
  parseDeepSeekHarnessCommand,
} from "../src/harness-commands.js";

const turnId = hostTurnIdSchema.parse("command-turn");

describe("DeepSeek Harness static command registry", () => {
  it("provides exactly three valid commands without native discovery", () => {
    const catalog = deepSeekHarnessCommandCatalog();
    expect(harnessCommandCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(
      catalog.commands.map(({ id, invocation, argumentMode }) => ({
        id,
        invocation,
        argumentMode,
      })),
    ).toEqual([
      { id: "dsh.compact", invocation: "/compact", argumentMode: "none" },
      { id: "dsh.goal", invocation: "/dsh-goal", argumentMode: "text" },
      { id: "dsh.plan", invocation: "/plan", argumentMode: "text" },
    ]);
  });

  it("parses compact without arguments and rejects unknown IDs or arguments", () => {
    expect(parseDeepSeekHarnessCommand({ turnId, commandId: "dsh.compact" })).toEqual({
      ok: true,
      value: { commandId: "dsh.compact", line: "/compact" },
    });
    expect(
      parseDeepSeekHarnessCommand({ turnId, commandId: "dsh.compact", arguments: {} }),
    ).toMatchObject({ ok: true });
    expect(
      parseDeepSeekHarnessCommand({
        turnId,
        commandId: "dsh.compact",
        arguments: { text: "keep details" },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(parseDeepSeekHarnessCommand({ turnId, commandId: "dsh.future" })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
  });

  it.each([
    ["dsh.goal", undefined, "/goal"],
    ["dsh.goal", "   ", "/goal"],
    ["dsh.goal", "  ship the release  ", "/goal ship the release"],
    ["dsh.goal", "edit replace the objective", "/goal edit replace the objective"],
    ["dsh.goal", "clear", "/goal clear"],
    ["dsh.goal", "pause", "/goal pause"],
    ["dsh.goal", "resume", "/goal resume"],
    ["dsh.plan", undefined, "/plan"],
    ["dsh.plan", "   ", "/plan"],
    ["dsh.plan", "  sketch the layout  ", "/plan sketch the layout"],
    ["dsh.plan", "off", "/plan off"],
  ])("maps %s %s to the native line", (commandId, text, line) => {
    expect(
      parseDeepSeekHarnessCommand({
        turnId,
        commandId,
        ...(text === undefined ? {} : { arguments: { text } }),
      }),
    ).toEqual({ ok: true, value: { commandId, line } });
  });

  it("rejects bare goal edits", () => {
    for (const text of ["edit", " EDIT ", "edit   "]) {
      expect(
        parseDeepSeekHarnessCommand({ turnId, commandId: "dsh.goal", arguments: { text } }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    }
  });

  it.each(["dsh.goal", "dsh.plan"])("validates text arguments for %s", (commandId) => {
    for (const arguments_ of [{ text: 123 }, { unexpected: true }]) {
      expect(
        parseDeepSeekHarnessCommand({ turnId, commandId, arguments: arguments_ }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    }
  });
});
