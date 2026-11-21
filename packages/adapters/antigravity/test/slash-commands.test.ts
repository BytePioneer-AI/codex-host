import {
  harnessCommandCatalogSchema,
  hostTurnIdSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { buildLiveCommandCatalog } from "../src/acp-projection.js";
import {
  ANTIGRAVITY_COMMAND_CATALOG,
  findAntigravityCommandDescriptor,
  parseAndFormatAntigravityCommand,
} from "../src/slash-commands.js";

const turnId = hostTurnIdSchema.parse("turn-command");
const builtInNames = [
  "plan",
  "goal",
  "browser",
  "grill-me",
  "boost",
  "learn",
  "schedule",
  "compact",
  "help",
];

describe("Antigravity slash command catalog", () => {
  it("conforms to the public schema and includes the built-in commands", () => {
    expect(harnessCommandCatalogSchema.safeParse(ANTIGRAVITY_COMMAND_CATALOG).success).toBe(true);
    expect(ANTIGRAVITY_COMMAND_CATALOG.commands.map(({ invocation }) => invocation)).toEqual(
      builtInNames.map((name) => `/${name}`),
    );
    for (const command of ANTIGRAVITY_COMMAND_CATALOG.commands) {
      expect(command.id).toMatch(/^antigravity\./);
      expect(command.argumentMode).toBe("text");
      expect(command.label.length).toBeGreaterThan(0);
      expect(command.description?.length).toBeGreaterThan(0);
    }
  });

  it.each(builtInNames)("resolves %s by ID, invocation and suffix", (name) => {
    const descriptor = findAntigravityCommandDescriptor(`antigravity.${name}`);
    expect(descriptor?.invocation).toBe(`/${name}`);
    expect(findAntigravityCommandDescriptor(`/${name}`)).toEqual(descriptor);
    expect(findAntigravityCommandDescriptor(name)).toEqual(descriptor);
  });

  it("does not resolve unknown commands", () => {
    expect(findAntigravityCommandDescriptor("unknown")).toBeUndefined();
    expect(parseAndFormatAntigravityCommand({ turnId, commandId: "unknown" })).toMatchObject({
      ok: false,
      error: { code: "unsupported", retryable: false },
    });
  });
});

describe("Antigravity command formatting", () => {
  it.each(builtInNames)("formats bare /%s without arguments", (name) => {
    expect(parseAndFormatAntigravityCommand({ turnId, commandId: name })).toMatchObject({
      ok: true,
      value: { prompt: `/${name}`, descriptor: { id: `antigravity.${name}` } },
    });
  });

  it.each([
    ["  refactor authentication  ", "/plan refactor authentication"],
    ["   ", "/plan"],
    ["", "/plan"],
  ])("trims argument text %j", (text, prompt) => {
    expect(
      parseAndFormatAntigravityCommand({ turnId, commandId: "/plan", arguments: { text } }),
    ).toMatchObject({
      ok: true,
      value: { prompt },
    });
  });

  const invalidArguments: JsonObject[] = [
    { text: 123 },
    { text: false },
    { text: ["not text"] },
    { text: {} },
    { text: "ok", extra: "unknown" },
  ];
  it.each(invalidArguments)("rejects invalid arguments %j", (arguments_) => {
    expect(
      parseAndFormatAntigravityCommand({ turnId, commandId: "plan", arguments: arguments_ }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalidRequest", retryable: false },
    });
  });
});

describe("dynamic ACP slash commands", () => {
  const catalog = buildLiveCommandCatalog([{ name: "quota", description: "Quota" }]);

  it.each(["antigravity.quota", "/quota", "quota"])(
    "finds and formats %s from the live catalog",
    (commandId) => {
      expect(findAntigravityCommandDescriptor(commandId, catalog)?.invocation).toBe("/quota");
      expect(
        parseAndFormatAntigravityCommand(
          { turnId, commandId, arguments: { text: "  details  " } },
          catalog,
        ),
      ).toMatchObject({ ok: true, value: { prompt: "/quota details" } });
    },
  );

  it("does not resolve a live command against the default catalog", () => {
    expect(parseAndFormatAntigravityCommand({ turnId, commandId: "quota" })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
  });

  it("honors a dynamic no-argument descriptor", () => {
    const noArgs = harnessCommandCatalogSchema.parse({
      commands: [
        { id: "antigravity.info", invocation: "/info", label: "Info", argumentMode: "none" },
      ],
    });
    expect(parseAndFormatAntigravityCommand({ turnId, commandId: "info" }, noArgs)).toMatchObject({
      ok: true,
      value: { prompt: "/info" },
    });
    expect(
      parseAndFormatAntigravityCommand(
        { turnId, commandId: "info", arguments: { text: "oops" } },
        noArgs,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
  });

  it("merges native commands without replacing built-ins or accepting invalid names", () => {
    const merged = buildLiveCommandCatalog([
      { name: "quota", description: "Quota" },
      { name: "/plan", description: "Duplicate" },
      { name: "quota", description: "Duplicate quota" },
      { name: "two words", description: "Invalid" },
      { name: "", description: "Empty" },
    ]);
    expect(merged.commands.filter(({ invocation }) => invocation === "/plan")).toEqual([
      findAntigravityCommandDescriptor("plan"),
    ]);
    expect(merged.commands.filter(({ invocation }) => invocation === "/quota")).toHaveLength(1);
    expect(findAntigravityCommandDescriptor("quota", merged)).toMatchObject({
      description: "Quota",
    });
    expect(merged.commands).toHaveLength(ANTIGRAVITY_COMMAND_CATALOG.commands.length + 1);
    expect(buildLiveCommandCatalog([])).toEqual(ANTIGRAVITY_COMMAND_CATALOG);
  });
});
