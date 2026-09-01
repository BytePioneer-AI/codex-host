import { describe, expect, it } from "vitest";

import type { HarnessCommandInvocation } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import {
  buildDeepSeekHarnessCommandLine,
  deepSeekHarnessCommandCatalog,
  parseDeepSeekHarnessCommand,
} from "../src/harness-commands.js";

const turnId = hostTurnIdSchema.parse("command-turn");

describe("DeepSeek Harness command registry", () => {
  it("exposes compact only when the current native catalog advertises its exact shape", () => {
    expect(
      deepSeekHarnessCommandCatalog([
        { name: "future", description: "A future command" },
        { name: "compact", description: "  Compact older conversation history  " },
      ]),
    ).toEqual({
      commands: [
        {
          id: "dsh.compact",
          invocation: "/compact",
          label: "Compact context",
          description: "Compact older conversation history",
          argumentMode: "none",
        },
      ],
    });

    expect(
      deepSeekHarnessCommandCatalog([
        {
          name: "compact",
          description: "Compact with instructions",
          input: { hint: "<instructions>" },
        },
      ]),
    ).toEqual({ commands: [] });
    expect(deepSeekHarnessCommandCatalog([])).toEqual({ commands: [] });
  });

  it("omits compact when its native description cannot enter the Host catalog", () => {
    expect(deepSeekHarnessCommandCatalog([{ name: "compact", description: "   " }])).toEqual({
      commands: [],
    });
    expect(
      deepSeekHarnessCommandCatalog([{ name: "compact", description: "x".repeat(513) }]),
    ).toEqual({ commands: [] });
  });

  it("exposes goal only when the current native catalog advertises text input", () => {
    expect(
      deepSeekHarnessCommandCatalog([
        {
          name: "goal",
          description: "set or view the goal for a long-running task",
          input: {
            hint: "[<objective>|clear|edit <objective>|pause|resume]",
            images: true,
          },
        },
      ]),
    ).toEqual({
      commands: [
        {
          id: "dsh.goal",
          invocation: "/dsh-goal",
          label: "Goal",
          description: "set or view the goal for a long-running task",
          argumentMode: "text",
        },
      ],
    });
    expect(deepSeekHarnessCommandCatalog([{ name: "goal", description: "Missing input" }])).toEqual(
      { commands: [] },
    );
  });

  it("parses compact without arguments and rejects unknown IDs or arguments", () => {
    expect(parseDeepSeekHarnessCommand({ turnId, commandId: "dsh.compact" })).toEqual({
      ok: true,
      value: { commandId: "dsh.compact", line: "/compact" },
    });
    expect(
      parseDeepSeekHarnessCommand({ turnId, commandId: "dsh.compact", arguments: {} }),
    ).toEqual({
      ok: true,
      value: { commandId: "dsh.compact", line: "/compact" },
    });
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

  it("builds an exact text command line without registering that command", () => {
    const descriptor = {
      id: "dsh.synthetic",
      invocation: "/synthetic",
      argumentMode: "text" as const,
    };
    const command = (
      arguments_?: HarnessCommandInvocation["arguments"],
    ): HarnessCommandInvocation => ({
      turnId,
      commandId: "dsh.synthetic",
      ...(arguments_ ? { arguments: arguments_ } : {}),
    });

    expect(buildDeepSeekHarnessCommandLine(command(), descriptor)).toEqual({
      ok: true,
      value: "/synthetic",
    });
    expect(buildDeepSeekHarnessCommandLine(command({ text: "" }), descriptor)).toEqual({
      ok: true,
      value: "/synthetic",
    });
    expect(
      buildDeepSeekHarnessCommandLine(command({ text: "edit objective" }), descriptor),
    ).toEqual({ ok: true, value: "/synthetic edit objective" });
    expect(buildDeepSeekHarnessCommandLine(command({ text: 1 }), descriptor)).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
    expect(buildDeepSeekHarnessCommandLine(command({ extra: true }), descriptor)).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
  });

  it("maps goal grammar to exact command lines", () => {
    for (const [text, expected] of [
      [undefined, "/goal"],
      ["   ", "/goal"],
      ["  ship the release  ", "/goal ship the release"],
      ["edit replace the objective", "/goal edit replace the objective"],
      ["clear", "/goal clear"],
      ["pause", "/goal pause"],
      ["resume", "/goal resume"],
    ] as const) {
      expect(
        parseDeepSeekHarnessCommand({
          turnId,
          commandId: "dsh.goal",
          ...(text === undefined ? {} : { arguments: { text } }),
        }),
      ).toEqual({ ok: true, value: { commandId: "dsh.goal", line: expected } });
    }
  });

  it("rejects bare goal edits", () => {
    for (const text of ["edit", " EDIT ", "edit   "]) {
      expect(
        parseDeepSeekHarnessCommand({
          turnId,
          commandId: "dsh.goal",
          arguments: { text },
        }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    }
  });

  it("exposes plan only when the current native catalog advertises text input", () => {
    expect(
      deepSeekHarnessCommandCatalog([
        {
          name: "plan",
          description: "Enter or leave plan mode",
          input: { hint: "[off|message]", images: true },
        },
      ]),
    ).toEqual({
      commands: [
        {
          id: "dsh.plan",
          invocation: "/plan",
          label: "Plan mode",
          description: "Enter or leave plan mode",
          argumentMode: "text",
        },
      ],
    });
    expect(deepSeekHarnessCommandCatalog([{ name: "plan", description: "Missing input" }])).toEqual(
      { commands: [] },
    );
  });

  it("maps plan messages to exact command lines", () => {
    for (const [text, expected] of [
      [undefined, "/plan"],
      ["   ", "/plan"],
      ["  sketch the layout  ", "/plan sketch the layout"],
      ["off", "/plan off"],
    ] as const) {
      expect(
        parseDeepSeekHarnessCommand({
          turnId,
          commandId: "dsh.plan",
          ...(text === undefined ? {} : { arguments: { text } }),
        }),
      ).toEqual({ ok: true, value: { commandId: "dsh.plan", line: expected } });
    }
  });

  it("filters client-only, first-class, export, and unknown native commands", () => {
    expect(
      deepSeekHarnessCommandCatalog([
        { name: "model", description: "Client model command", input: { hint: "<model>" } },
        {
          name: "goal",
          description: "Goal",
          input: { hint: "[objective]", images: true },
        },
        {
          name: "permission",
          description: "Permission Mode",
          input: { hint: "<preset>" },
        },
        { name: "compact", description: "Compact" },
        { name: "export", description: "Export" },
        {
          name: "feedback",
          description: "Feedback",
          input: { hint: "<text>" },
        },
        { name: "future", description: "Future command", input: { hint: "[args]" } },
        {
          name: "plan",
          description: "Plan",
          input: { hint: "[off|message]", images: true },
        },
      ]).commands.map(({ id }) => id),
    ).toEqual(["dsh.goal", "dsh.compact", "dsh.plan"]);
  });
});
