import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter, HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CodeBuddyAdapter } from "../src/codebuddy-adapter.js";
import { commandCatalog, commandPrompt } from "../src/slash-commands.js";
import { fixture } from "./fixtures.js";
const adapters: CodeBuddyAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.close()));
});
const turnId = hostTurnIdSchema.parse("command-turn");

describe("CodeBuddy native slash commands", () => {
  it("exposes the command-button catalog without opening a native Session", () => {
    const clientFactory = vi.fn(() => {
      throw new Error("metadata must not start a native process");
    });
    const adapter = new CodeBuddyAdapter({ clientFactory });
    adapters.push(adapter);
    const hostAdapter: HarnessAdapter = adapter;
    expect(hostAdapter.commandCatalog?.commands.map((command) => command.invocation)).toEqual([
      "/compact",
      "/cost",
    ]);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("retains native names and arguments while excluding Session switches and malformed entries", () => {
    const catalog = commandCatalog([
      { name: "compact", description: "Summary" },
      { name: "compact" },
      { name: "fork" },
      { name: "clear" },
      { name: "background" },
      { name: "login" },
      { name: "bad/name" },
      { name: "review", input: { hint: "[target]" } },
      { name: "skill", _meta: { type: "skill" } },
    ]);
    expect(catalog.commands.map((c) => [c.id, c.argumentMode])).toEqual([
      ["codebuddy.compact", "text"],
      ["codebuddy.review", "text"],
      ["codebuddy.skill", "text"],
    ]);
    expect(
      commandPrompt(
        { turnId, commandId: "codebuddy.compact", arguments: { text: " retain decisions " } },
        catalog,
      ),
    ).toEqual({ ok: true, value: "/compact retain decisions" });
    expect(commandPrompt({ turnId, commandId: "codebuddy.fork" }, catalog)).toMatchObject({
      error: { code: "unsupported" },
    });
    expect(
      commandPrompt({ turnId, commandId: "codebuddy.compact", arguments: { text: 3 } }, catalog),
    ).toMatchObject({ error: { code: "invalidRequest" } });
  });

  it("runs local commands without inventing Native Turn identity and preserves later prompt history", async () => {
    const native = fixture();
    const adapter = new CodeBuddyAdapter(native);
    adapters.push(adapter);
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw Error(opened.error.message);
    const session = opened.value,
      outputs: HarnessOutput[] = [];
    for (const text of ["/clear", " /fork example", "/resume\nold-session", "/background task"]) {
      expect(
        await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text }] }),
      ).toMatchObject({ error: { code: "unsupported" } });
    }
    expect(native.history).toEqual([]);
    void (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    const terminal = () =>
      outputs.filter((o) => o.kind === "event" && o.event.type === "turn.completed");
    expect(await session.commands?.list()).toMatchObject({
      value: {
        commands: [
          { id: "codebuddy.compact" },
          { id: "codebuddy.cost" },
          { id: "codebuddy.review" },
        ],
      },
    });
    expect(
      await session.commands?.execute({
        turnId,
        commandId: "codebuddy.cost",
        arguments: { text: "bad" },
      }),
    ).toMatchObject({ error: { code: "invalidRequest" } });
    expect(await session.commands?.execute({ turnId, commandId: "codebuddy.cost" })).toMatchObject({
      ok: true,
    });
    await vi.waitFor(() => expect(terminal()).toHaveLength(1));
    expect(terminal()[0]).toEqual({
      kind: "event",
      event: { type: "turn.completed", turnId, outcome: { status: "succeeded" } },
    });
    expect(await session.readSnapshot()).toMatchObject({ value: { turns: [] } });
    await session.commands?.execute({
      turnId: hostTurnIdSchema.parse("compact"),
      commandId: "codebuddy.compact",
      arguments: { text: "keep decisions" },
    });
    await vi.waitFor(() => expect(terminal()).toHaveLength(2));
    // An advertised command whose native result has no compaction marker must
    // not fabricate a successful compaction Item.
    expect(
      outputs.some(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.started" &&
          o.event.item.type === "contextCompaction",
      ),
    ).toBe(false);
    expect(native.history[0]).toMatchObject({ content: [{ text: "/compact keep decisions" }] });
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("next"),
      input: [{ type: "text", text: "hold" }],
    });
    expect(await session.commands?.execute({ turnId, commandId: "codebuddy.cost" })).toMatchObject({
      error: { code: "sessionBusy" },
    });
    await session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("next") });
    await vi.waitFor(() => expect(terminal()).toHaveLength(3));
    expect(await session.commands?.list()).toMatchObject({
      value: {
        commands: expect.arrayContaining([
          {
            id: "codebuddy.cost",
            invocation: "/cost",
            label: "cost",
            description: "Cost",
            argumentMode: "none",
          },
        ]),
      },
    });
    native.clients
      .at(-1)
      ?.update({ sessionUpdate: "available_commands_update", availableCommands: [] });
    expect(await session.commands?.execute({ turnId, commandId: "codebuddy.cost" })).toMatchObject({
      error: { code: "unsupported" },
    });
    await session.close();
    expect(await session.commands?.list()).toMatchObject({ error: { code: "invalidState" } });
  });
});
