import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeSessionRefSchema, nativeCheckpointRefSchema } from "@codexhost/shared-contracts";
import { assertCopiedPrefix, deriveCodeBuddySession, retainedRowCount } from "../src/derivation.js";
import { codeBuddyNativeHistory, nativeHistoryRows, snapshotFromHistory } from "../src/history.js";
import { CodeBuddySession } from "../src/session.js";
import { modelRef } from "../src/configuration.js";
import type { CodeBuddyClientFactory } from "../src/acp-client.js";
import { configOptions, fixture } from "./fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const ref = nativeSessionRefSchema.parse({
  harnessId: "codebuddy",
  nativeSessionId: "source",
  formatVersion: 1,
});
const checkpoint = nativeCheckpointRefSchema.parse({
  harnessId: "codebuddy",
  nativeSessionId: "source",
  checkpointId: "u1",
  formatVersion: 1,
});
const rows = [
  { id: "u1", type: "message", role: "user", content: "one" },
  {
    id: "a1",
    parentId: "u1",
    type: "message",
    role: "assistant",
    content: "answer",
    status: "completed",
  },
  {
    id: "tool",
    parentId: "a1",
    type: "function_call",
    name: "Read",
    callId: "call",
    arguments: {},
  },
  {
    id: "result",
    parentId: "tool",
    type: "function_call_result",
    callId: "call",
    output: "file",
    status: "completed",
  },
  { id: "u2", parentId: "result", type: "message", role: "user", content: "two" },
  {
    id: "a2",
    parentId: "u2",
    type: "message",
    role: "assistant",
    content: "last",
    status: "completed",
  },
];
const jsonl = (items: unknown[]) => items.map((row) => JSON.stringify(row)).join("\n") + "\n";

async function setup(
  options: {
    advertised?: boolean;
    corrupt?: boolean;
    badRewind?: boolean;
    forkFailure?: boolean;
    sourceRace?: boolean;
    copyFailure?: boolean;
    cleanupFailure?: boolean;
  } = {},
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "cb-derive-"));
  roots.push(cwd);
  const environment = { CODEBUDDY_CONFIG_DIR: path.join(cwd, "config") };
  const directory = path.join(environment.CODEBUDDY_CONFIG_DIR, "projects", "fixture");
  await mkdir(directory, { recursive: true });
  const file = (id: string) => path.join(directory, `${id}.jsonl`);
  const original = rows.map((row) => ({ ...row, sessionId: "source", cwd }));
  const contents = jsonl(original);
  await writeFile(file("source"), contents);
  const close = vi.fn(async () => {}),
    prompt = vi.fn(),
    rollback = vi.fn();
  const copy = vi.fn(async (_cwd: string, _source: string, target: string) => {
    if (options.copyFailure) throw Error("copy failed");
    await writeFile(
      file(target),
      contents + jsonl([{ type: "session-meta", sessionId: target, meta: {} }]),
    );
  });
  const removeCopy = vi.fn(async () => {});
  const factory: CodeBuddyClientFactory = (context) => ({
    removeCopy: async () => {
      removeCopy();
      if (options.cleanupFailure) throw new Error("native cleanup failed");
      if (!context.temporarySessionId) throw new Error("missing owned copy");
      await rm(file(context.temporarySessionId), { force: true });
    },
    initialize: async () => ({}),
    open: async () => {
      context.handlers.update({
        sessionId: "source",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands:
            options.advertised === false ? [] : [{ name: "fork", description: "Fork" }],
        },
      });
      return { configOptions: configOptions() };
    },
    prompt: async (_sessionId, text) => {
      prompt(text);
      if (options.forkFailure) throw Error("fork failed");
      const clones = original.map((row) => {
        const rest: Record<string, unknown> = { ...row };
        delete rest.sessionId;
        return {
          ...rest,
          id: `new-${row.id}`,
          ...(row.parentId ? { parentId: `new-${row.parentId}` } : {}),
        };
      });
      if (options.corrupt && clones[0]) Object.assign(clones[0], { content: "changed" });
      await writeFile(
        file("derived"),
        jsonl([
          ...clones,
          {
            id: "fork-command",
            parentId: "new-a2",
            type: "message",
            role: "user",
            content: "/fork",
            sessionId: "derived",
            cwd,
          },
        ]),
      );
      if (options.sourceRace)
        await writeFile(
          file("source"),
          contents + jsonl([{ type: "session-meta", sessionId: "source", meta: {} }]),
        );
      context.handlers.update({
        sessionId: "derived",
        update: {
          sessionUpdate: "session_info_update",
          _meta: { "codebuddy.ai/sessionReset": true, "codebuddy.ai/newSessionId": "derived" },
        },
      });
      return { stopReason: "end_turn" };
    },
    rollback: async (_sessionId, point) => {
      rollback(point);
      if (!options.badRewind)
        await writeFile(
          file("derived"),
          (await readFile(file("derived"), "utf8")) +
            jsonl([
              {
                type: "resend-fork-notice",
                id: "rewind",
                ...(point ? { parentId: point } : {}),
                providerData: { skipRun: true, resendForkNotice: true },
              },
            ]),
        );
      return { applied: true, actualForkPointId: point };
    },
    configure: async () => ({}),
    cancel: async () => {},
    answer: async () => {},
    close,
  });
  const input = { kind: "fork" as const, cwd, sourceRef: ref, checkpoint };
  const run = (override = {}) =>
    deriveCodeBuddySession({
      input,
      factory,
      environment,
      copy,
      signal: new AbortController().signal,
      ...override,
    });
  return {
    cwd,
    environment,
    file,
    contents,
    copy,
    prompt,
    close,
    rollback,
    removeCopy,
    run,
    input,
    factory,
  };
}

describe("native CodeBuddy derivation", () => {
  it("forks through the complete tool suffix and keeps source bytes and stable native IDs", async () => {
    const fixture = await setup();
    const derived = await fixture.run();
    expect(fixture.prompt).toHaveBeenCalledWith("/fork");
    expect(fixture.rollback).toHaveBeenCalledWith("new-result");
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.removeCopy).toHaveBeenCalledOnce();
    await expect(
      readFile(fixture.file(fixture.copy.mock.calls[0]?.[2] ?? "missing-copy"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(fixture.file("source"), "utf8")).toBe(fixture.contents);
    const history = await codeBuddyNativeHistory(
      fixture.cwd,
      derived.nativeRef,
      fixture.environment,
    );
    expect(nativeHistoryRows(history.contents).map((row) => row.id)).toEqual([
      "new-u1",
      "new-a1",
      "new-tool",
      "new-result",
    ]);
    expect(
      snapshotFromHistory(history.contents, derived.nativeRef, fixture.cwd).turns[0]?.checkpoint
        ?.checkpointId,
    ).toBe("new-u1");
    expect(
      await codeBuddyNativeHistory(fixture.cwd, derived.nativeRef, fixture.environment),
    ).toEqual(history);
  });

  it("removes the owned copy on a failure after native Fork", async () => {
    const fixture = await setup({ corrupt: true });
    await expect(fixture.run()).rejects.toThrow("exact history prefix");
    expect(fixture.removeCopy).toHaveBeenCalledOnce();
    await expect(
      readFile(fixture.file(fixture.copy.mock.calls[0]?.[2] ?? "missing-copy"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(fixture.file("source"), "utf8")).toBe(fixture.contents);
  });

  it("does not return a successful derivation if native cleanup fails", async () => {
    const fixture = await setup({ cleanupFailure: true });
    await expect(fixture.run()).rejects.toThrow("native cleanup failed");
    expect(fixture.removeCopy).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("reports retained temporary data without hiding the original Fork failure", async () => {
    const fixture = await setup({ forkFailure: true, cleanupFailure: true });
    await expect(fixture.run()).rejects.toThrow(
      /fork failed; temporary Session .* could not be removed/u,
    );
    expect(fixture.removeCopy).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("uses explicit rollback configuration before inherited configuration", async () => {
    const fixture = await setup();
    const result = await fixture.run({
      input: {
        kind: "rollbackLastTurn",
        cwd: fixture.cwd,
        sourceRef: ref,
        model: modelRef("other"),
        permissionModeId: "plan",
        thinkingOptionId: "high",
      },
      state: {
        effectiveModel: modelRef("native/model"),
        effectivePermissionModeId: "default",
        effectiveThinkingOptionId: "low",
      },
    });
    expect(result).toMatchObject({
      model: modelRef("other"),
      permissionModeId: "plan",
      thinkingOptionId: "high",
    });
    expect(fixture.rollback).toHaveBeenCalledWith("new-result");
  });

  it.each([
    ["advertised", { advertised: false }, "does not advertise"],
    ["corrupted native prefix", { corrupt: true }, "exact history prefix"],
    ["unpersisted rewind", { badRewind: true }, "did not persist"],
    ["native error", { forkFailure: true }, "fork failed"],
    ["source changed", { sourceRace: true }, "Source history changed"],
  ])("fails closed and retires the process for %s", async (_name, options, message) => {
    const fixture = await setup(options);
    await expect(fixture.run()).rejects.toThrow(message);
    expect(fixture.close).toHaveBeenCalledOnce();
    if ("advertised" in options && options.advertised === false)
      expect(fixture.prompt).not.toHaveBeenCalled();
  });

  it("does not start ACP work after a failed copy or an invalid checkpoint", async () => {
    const fixture = await setup({ copyFailure: true });
    await expect(fixture.run()).rejects.toThrow("copy failed");
    expect(fixture.prompt).not.toHaveBeenCalled();
    await expect(
      fixture.run({
        input: { ...fixture.input, checkpoint: { ...checkpoint, checkpointId: "missing" } },
      }),
    ).rejects.toMatchObject({ code: "checkpointNotFound" });
    expect(fixture.copy).toHaveBeenCalledOnce();
  });

  it("closes an administrative client when adapter shutdown aborts derivation", async () => {
    const fixture = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(fixture.run({ signal: controller.signal })).rejects.toThrow("closed during Fork");
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.prompt).not.toHaveBeenCalled();
  });

  it("rejects foreign inherited history outside the private verified-copy transaction", async () => {
    const fixture = await setup();
    await fixture.copy(fixture.cwd, "source", "copy");
    const target = { ...ref, nativeSessionId: "copy" };
    await expect(codeBuddyNativeHistory(fixture.cwd, target, fixture.environment)).rejects.toThrow(
      "different Session identity",
    );
    await expect(
      codeBuddyNativeHistory(fixture.cwd, target, fixture.environment, fixture.contents),
    ).resolves.toBeDefined();
    await writeFile(fixture.file("copy"), fixture.contents.replace('"one"', '"tampered"'));
    await expect(
      codeBuddyNativeHistory(fixture.cwd, target, fixture.environment, fixture.contents),
    ).rejects.toThrow("different Session identity");
  });
});

describe("native rewind and configuration restoration", () => {
  it("excludes the next command's caveat and permits removal of the only Turn", () => {
    const caveat = {
      type: "message",
      id: "caveat",
      role: "user",
      content: [
        {
          type: "input_text",
          text: '<system-reminder data-role="command-caveat">notice</system-reminder>',
        },
      ],
      providerData: { skipRun: true },
    };
    const command = {
      type: "message",
      id: "command",
      parentId: "caveat",
      role: "user",
      content: [{ type: "input_text", text: "<command-name>/cost</command-name>" }],
      providerData: { skipRun: true },
    };
    const input = { kind: "rollbackLastTurn" as const, cwd: "/tmp", sourceRef: ref };
    expect(retainedRowCount(input, jsonl([caveat, command]))).toBe(0);
    expect(() => retainedRowCount(input, "")).toThrow("no Turn");
    const root = jsonl([
      ...rows,
      { type: "resend-fork-notice", id: "rewind", providerData: { resendForkNotice: true } },
    ]);
    expect(nativeHistoryRows(root)).toEqual([]);
    expect(
      nativeHistoryRows(
        root + jsonl([{ id: "new", type: "message", role: "user", content: "next" }]),
      ),
    ).toHaveLength(1);
  });

  it("checks parent edges as well as message content", () => {
    expect(() =>
      assertCopiedPrefix(
        rows,
        rows.map((row) => ({ ...row, parentId: undefined })),
      ),
    ).toThrow("exact history prefix");
  });

  it("restores saved derived settings on reload and lets caller selections override them", async () => {
    const nativeRef = {
      ...ref,
      locator: {
        codebuddyDerived: 1,
        configuration: { model: "other", mode: "plan", thinking: "high" },
      },
    };
    const f = fixture();
    const session = new CodeBuddySession(
      { kind: "resume", cwd: process.cwd(), nativeRef },
      process.env,
      f.clientFactory,
      async () => "",
    );
    try {
      await session.initialize();
      expect(session.initialState).toMatchObject({
        effectiveModel: modelRef("other"),
        effectivePermissionModeId: "plan",
        effectiveThinkingOptionId: "high",
        nativeRef,
      });
    } finally {
      await session.close();
    }
    const explicit = new CodeBuddySession(
      { kind: "resume", cwd: process.cwd(), nativeRef, model: modelRef("native/model") },
      process.env,
      f.clientFactory,
      async () => "",
    );
    try {
      await explicit.initialize();
      expect(explicit.initialState.effectiveModel).toEqual(modelRef("native/model"));
      expect(explicit.initialState.nativeRef?.locator).toMatchObject({
        configuration: { model: "native/model", mode: "plan", thinking: "high" },
      });
    } finally {
      await explicit.close();
    }
  });
});
