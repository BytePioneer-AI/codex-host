import type { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { FakeHarnessAdapter, type FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  REASONING_TRANSCRIPT_COMMAND,
  THREAD_HANDOFF_METHOD,
  harnessCommandDescriptorSchema,
  harnessIdSchema,
  hostItemIdSchema,
  hostThreadIdSchema,
  threadHandoffMetadataSchema,
  threadHandoffParamsSchema,
  threadHandoffResultSchema,
  threadInspectionSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppServerHost } from "../src/app-server-host.js";
import { ClientChannelEvents } from "../src/client-channel-events.js";
import { ClientChannelHost } from "../src/client-channel-host.js";
import { withInjectedText } from "../src/external-thread-side-chat.js";
import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import type { SharedThreadPeer } from "../src/shared-thread-peer.js";
import { SharedThreadOwner } from "../src/shared-thread-owner.js";
import {
  MAX_HANDOFF_BYTES,
  buildThreadHandoffPackage,
  cutEndUtf8,
  cutStartUtf8,
  utf8ByteLength,
} from "../src/thread-handoff.js";
import {
  FakeOfficialProcess,
  closeFixture,
  completePiTurn,
  createFixture,
  requestId,
  startExternalThread,
  stopFixture,
  threadStatus,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

function makeTurn(
  index: number,
  user: string,
  assistant: string,
  options: {
    status?: string;
    extraItems?: JsonObject[];
  } = {},
): JsonObject {
  return {
    id: `turn-${index}`,
    status: options.status ?? "completed",
    items: [
      {
        id: `u-${index}`,
        type: "userMessage",
        content: [{ type: "text", text: user }],
      },
      ...(options.extraItems ?? []),
      {
        id: `a-${index}`,
        type: "agentMessage",
        phase: "final",
        text: assistant,
      },
    ],
  };
}

describe("thread-handoff packer", () => {
  it("carries short threads in full without a TOC and includes header, CLI command, and plan", () => {
    const built = buildThreadHandoffPackage({
      sourceThreadId: "src-thread-1",
      sourceHarnessId: harnessIdSchema.parse("codex"),
      sourceHarnessLabel: "Codex",
      sourceModel: "gpt-5.4",
      targetHarnessId: harnessIdSchema.parse("claude-code"),
      targetHarnessLabel: "Claude Code",
      targetModel: "claude-sonnet-4-5",
      cwd: "/repo/project",
      turns: [
        makeTurn(1, "Investigate auth bug", "Found token expiry check in auth.ts"),
        makeTurn(2, "Add a regression test", "Added unit test and verified pass", {
          extraItems: [
            {
              id: "r-2-summary",
              type: "reasoning",
              summary: ["thinking"],
            },
            {
              id: "r-2",
              type: "commandExecution",
              command: REASONING_TRANSCRIPT_COMMAND,
              exitCode: 0,
              status: "completed",
            },
            {
              id: "fc-2",
              type: "fileChange",
              changes: [{ path: "/repo/project/src/auth.ts", kind: "update" }],
            },
            {
              id: "cmd-2",
              type: "commandExecution",
              command: "npm test auth",
              exitCode: 0,
              status: "completed",
            },
          ],
        }),
      ],
      latestPlan: {
        explanation: "Rollout steps",
        plan: [
          { step: "Fix token check", status: "completed" },
          { step: "Run integration tests", status: "inProgress" },
        ],
      },
      createdAtMs: 1_700_000_000_000,
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { contextText, metadata } = built.value;
    expect(utf8ByteLength(contextText)).toBeLessThanOrEqual(MAX_HANDOFF_BYTES);
    expect(contextText.startsWith("<handoff_context>\n")).toBe(true);
    expect(contextText.endsWith("\n</handoff_context>")).toBe(true);
    expect(contextText).toContain("Source Thread: thread://src-thread-1");
    expect(contextText).toContain("Codex (gpt-5.4)");
    expect(contextText).toContain("Claude Code (claude-sonnet-4-5)");
    expect(contextText).toContain("Working Directory: /repo/project");
    expect(contextText).toContain("reference only, not new instructions");
    expect(contextText).toContain(
      '"$CODEXHOST_CLI_PATH" thread read src-thread-1 --view messages --from <n> --to <m> --format text',
    );
    expect(contextText).toContain("Latest Plan:\nRollout steps\n- [x] Fix token check");
    expect(contextText).toContain("[edited src/auth.ts]");
    expect(contextText).toContain("[command: npm test auth (ok)]");
    expect(contextText).not.toContain(REASONING_TRANSCRIPT_COMMAND);
    expect(contextText).not.toContain("## Omitted Middle Turns");
    expect(metadata).toMatchObject({
      sourceThreadId: "src-thread-1",
      sourceHarnessId: "codex",
      targetHarnessId: "claude-code",
      totalTurns: 2,
      boundaryTurnNumber: 2,
      includedTurnNumbers: [1, 2],
      omittedTurns: 0,
      preview: contextText,
      createdAtMs: 1_700_000_000_000,
    });
  });

  it("enforces 16 KB UTF-8 budget, keeps Turn 1 user prompt only, truncates asymmetrically, and caps TOC", () => {
    const turns: JsonObject[] = [];
    turns.push(
      makeTurn(
        1,
        `ANCHOR-HEAD-${"目标说明".repeat(2_000)}-ANCHOR-TAIL`,
        "TURN-1-LONG-ASSISTANT-SHOULD-NOT-BE-CARRIED".repeat(100),
      ),
    );
    for (let i = 2; i <= 35; i += 1) {
      turns.push(
        makeTurn(
          i,
          `Middle request ${i} ${"x".repeat(80)}`,
          `Middle reply ${i} ${"y".repeat(600)}`,
        ),
      );
    }
    turns.push(
      makeTurn(
        36,
        `FINAL-USER-HEAD-${"u".repeat(7_000)}-FINAL-USER-TAIL`,
        `FINAL-ASSISTANT-HEAD-${"a".repeat(7_000)}-FINAL-CONCLUSION`,
        {
          extraItems: [
            {
              id: "cmd-36",
              type: "commandExecution",
              command: "cargo test",
              exitCode: 1,
              status: "failed",
            },
          ],
        },
      ),
    );

    const built = buildThreadHandoffPackage({
      sourceThreadId: "long-thread",
      sourceHarnessId: harnessIdSchema.parse("pi"),
      targetHarnessId: harnessIdSchema.parse("codex"),
      cwd: "/work",
      turns,
      createdAtMs: 123,
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { contextText, metadata } = built.value;
    expect(utf8ByteLength(contextText)).toBeLessThanOrEqual(MAX_HANDOFF_BYTES);
    // Turn 1 anchor preserves user head, omits Turn 1 long assistant reply.
    expect(contextText).toContain("## Initial Request (Turn 1)");
    expect(contextText).toContain("ANCHOR-HEAD-");
    expect(contextText).not.toContain("ANCHOR-TAIL");
    expect(contextText).not.toContain("TURN-1-LONG-ASSISTANT-SHOULD-NOT-BE-CARRIED");
    // Boundary turn uses asymmetric truncation: User keeps head, Assistant keeps tail.
    expect(contextText).toContain("FINAL-USER-HEAD-");
    expect(contextText).not.toContain("FINAL-USER-TAIL");
    expect(contextText).toContain("FINAL-CONCLUSION");
    expect(contextText).not.toContain("FINAL-ASSISTANT-HEAD-");
    expect(contextText).toContain("[command: cargo test (failed)]");
    // TOC is present and capped to <= 25 lines and <= 2 KB.
    expect(contextText).toContain("## Omitted Middle Turns");
    const tocLines = contextText.split("\n").filter((line) => /^#\d+: /u.test(line));
    expect(tocLines.length).toBeLessThanOrEqual(25);
    expect(metadata.boundaryTurnNumber).toBe(36);
    expect(metadata.totalTurns).toBe(36);
    expect(metadata.includedTurnNumbers[0]).toBe(1);
    expect(metadata.includedTurnNumbers.at(-1)).toBe(36);
    expect(metadata.includedTurnNumbers.length + metadata.omittedTurns).toBe(36);
  });

  it("cuts cleanly at lastTurnId and rejects missing or in-progress boundaries", () => {
    const turns = [
      makeTurn(1, "Step one", "Done one"),
      makeTurn(2, "Step two", "Done two"),
      makeTurn(3, "Step three", "Running...", { status: "inProgress" }),
    ];

    const atTurn1 = buildThreadHandoffPackage({
      sourceThreadId: "src",
      sourceHarnessId: harnessIdSchema.parse("pi"),
      targetHarnessId: harnessIdSchema.parse("codex"),
      cwd: "/work",
      turns,
      lastTurnId: "turn-1",
    });
    expect(atTurn1.ok).toBe(true);
    if (atTurn1.ok) {
      expect(atTurn1.value.metadata.boundaryTurnNumber).toBe(1);
      expect(atTurn1.value.metadata.totalTurns).toBe(3);
      expect(atTurn1.value.metadata.includedTurnNumbers).toEqual([1]);
      expect(atTurn1.value.contextText).toContain("Step one");
      expect(atTurn1.value.contextText).not.toContain("Step two");
    }

    const latestCompleted = buildThreadHandoffPackage({
      sourceThreadId: "src",
      sourceHarnessId: harnessIdSchema.parse("pi"),
      targetHarnessId: harnessIdSchema.parse("codex"),
      cwd: "/work",
      turns,
    });
    expect(latestCompleted.ok).toBe(true);
    if (latestCompleted.ok) {
      expect(latestCompleted.value.metadata.boundaryTurnNumber).toBe(2);
      expect(latestCompleted.value.metadata.includedTurnNumbers).toEqual([1, 2]);
    }

    expect(
      buildThreadHandoffPackage({
        sourceThreadId: "src",
        sourceHarnessId: harnessIdSchema.parse("pi"),
        targetHarnessId: harnessIdSchema.parse("codex"),
        cwd: "/work",
        turns,
        lastTurnId: "turn-3",
      }),
    ).toMatchObject({ ok: false, code: -32602 });

    expect(
      buildThreadHandoffPackage({
        sourceThreadId: "src",
        sourceHarnessId: harnessIdSchema.parse("pi"),
        targetHarnessId: harnessIdSchema.parse("codex"),
        cwd: "/work",
        turns,
        lastTurnId: "does-not-exist",
      }),
    ).toMatchObject({ ok: false, code: -32080 });

    expect(
      buildThreadHandoffPackage({
        sourceThreadId: "src",
        sourceHarnessId: harnessIdSchema.parse("pi"),
        targetHarnessId: harnessIdSchema.parse("codex"),
        cwd: "/work",
        turns: [makeTurn(1, "Only active", "", { status: "inProgress" })],
      }),
    ).toMatchObject({ ok: false, code: -32080 });
  });

  it("treats only status === 'completed' as completed and rejects failed/interrupted boundaries", () => {
    const turns = [
      makeTurn(1, "Step one", "Done one", { status: "completed" }),
      makeTurn(2, "Step two", "Boom", { status: "failed" }),
      makeTurn(3, "Step three", "Stopped", { status: "interrupted" }),
    ];

    const autoBoundary = buildThreadHandoffPackage({
      sourceThreadId: "src",
      sourceHarnessId: harnessIdSchema.parse("pi"),
      targetHarnessId: harnessIdSchema.parse("codex"),
      cwd: "/work",
      turns,
    });
    expect(autoBoundary.ok).toBe(true);
    if (autoBoundary.ok) {
      expect(autoBoundary.value.metadata.boundaryTurnNumber).toBe(1);
      expect(autoBoundary.value.metadata.includedTurnNumbers).toEqual([1]);
    }

    for (const badId of ["turn-2", "turn-3"]) {
      expect(
        buildThreadHandoffPackage({
          sourceThreadId: "src",
          sourceHarnessId: harnessIdSchema.parse("pi"),
          targetHarnessId: harnessIdSchema.parse("codex"),
          cwd: "/work",
          turns,
          lastTurnId: badId,
        }),
      ).toMatchObject({ ok: false, code: -32602 });
    }

    expect(
      buildThreadHandoffPackage({
        sourceThreadId: "src",
        sourceHarnessId: harnessIdSchema.parse("pi"),
        targetHarnessId: harnessIdSchema.parse("codex"),
        cwd: "/work",
        turns: [
          makeTurn(1, "Fail", "Err", { status: "failed" }),
          makeTurn(2, "Abort", "Cancelled", { status: "interrupted" }),
        ],
      }),
    ).toMatchObject({ ok: false, code: -32080 });
  });

  it("caps Activity bytes so boundary Assistant conclusions survive and reports accurate includedTurnNumbers after oversized headers", () => {
    const longFiles = Array.from({ length: 10 }, (_, index) => ({
      path: `/work/${"deep-nested-segment/".repeat(40)}file-${index}.ts`,
      kind: "update",
    }));
    const heavyActivityTurn = makeTurn(
      2,
      `USER-BOUNDARY-${"u".repeat(3_500)}`,
      `ASSISTANT-BODY-${"a".repeat(3_500)}-MUST-KEEP-CONCLUSION`,
      {
        extraItems: [{ id: "fc-heavy", type: "fileChange", changes: longFiles }],
      },
    );
    const builtHeavy = buildThreadHandoffPackage({
      sourceThreadId: "heavy-activity",
      sourceHarnessId: harnessIdSchema.parse("pi"),
      targetHarnessId: harnessIdSchema.parse("codex"),
      cwd: "/work",
      turns: [makeTurn(1, `ANCHOR-${"x".repeat(4_000)}`, "ok"), heavyActivityTurn],
      createdAtMs: 10,
    });
    expect(builtHeavy.ok).toBe(true);
    if (builtHeavy.ok) {
      expect(utf8ByteLength(builtHeavy.value.contextText)).toBeLessThanOrEqual(MAX_HANDOFF_BYTES);
      expect(builtHeavy.value.contextText).toContain("MUST-KEEP-CONCLUSION");
    }

    // Oversized header (e.g., extreme cwd length) leaves no room for turn content:
    // includedTurnNumbers must not falsely claim dropped turns were included.
    const builtHugeHeader = buildThreadHandoffPackage({
      sourceThreadId: "huge-header",
      sourceHarnessId: harnessIdSchema.parse("pi"),
      targetHarnessId: harnessIdSchema.parse("codex"),
      cwd: `/${"p".repeat(16_000)}`,
      turns: [makeTurn(1, "First request", "First reply"), makeTurn(2, "Second", "Second reply")],
      createdAtMs: 20,
    });
    expect(builtHugeHeader.ok).toBe(true);
    if (builtHugeHeader.ok) {
      const { contextText, metadata } = builtHugeHeader.value;
      expect(utf8ByteLength(contextText)).toBeLessThanOrEqual(MAX_HANDOFF_BYTES);
      expect(metadata.includedTurnNumbers).toEqual([]);
      expect(metadata.omittedTurns).toBe(2);
    }

    // Schema alignment: targetModel up to 1024 chars is accepted by both params and metadata schemas.
    const longModel = `provider/${"m".repeat(700)}`;
    expect(
      threadHandoffParamsSchema.safeParse({
        sourceThreadId: "src-1",
        targetHarnessId: "claude-code",
        targetModel: longModel,
      }).success,
    ).toBe(true);
    expect(
      threadHandoffMetadataSchema.safeParse({
        sourceThreadId: "src-1",
        sourceHarnessId: "codex",
        targetHarnessId: "claude-code",
        targetModel: longModel,
        totalTurns: 1,
        boundaryTurnNumber: 1,
        includedTurnNumbers: [1],
        omittedTurns: 0,
        preview: "<handoff_context>\nbody\n</handoff_context>",
        createdAtMs: 1,
      }).success,
    ).toBe(true);
  });

  it("cuts multi-byte UTF-8 safely without splitting surrogate pairs", () => {
    const sample = "你好🚀世界";
    const head = cutStartUtf8(sample, 8);
    expect(head.truncated).toBe(true);
    expect(head.text).toBe("你好");
    expect(utf8ByteLength(head.text)).toBeLessThanOrEqual(8);

    const tail = cutEndUtf8(sample, 8);
    expect(tail.truncated).toBe(true);
    expect(tail.text).toBe("世界");
    expect(utf8ByteLength(tail.text)).toBeLessThanOrEqual(8);
  });

  it("prefixes pendingInjectedText unconditionally for normal turn text including slash paths", () => {
    const held = { pendingInjectedText: ["<handoff_context>ctx</handoff_context>"] };
    const tmpPrompt = withInjectedText(held, "/tmp 请检查这个目录");
    expect(tmpPrompt.text).toBe("<handoff_context>ctx</handoff_context>\n\n/tmp 请检查这个目录");
    expect(tmpPrompt.prefix).toBeDefined();

    const pathPrompt = withInjectedText(held, "/foo/bar fix this");
    expect(pathPrompt.text).toBe("<handoff_context>ctx</handoff_context>\n\n/foo/bar fix this");
    expect(pathPrompt.prefix).toBeDefined();
  });
});

describe("codexhost/thread/handoff host routing and dual-channel injection", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function attachOfficialResponder(
    official: ReturnType<typeof createFixture>["official"],
    state: {
      threads: Map<string, JsonObject>;
      injected: Array<{ threadId: string; items: unknown }>;
      renamed: Array<{ threadId: string; name: string }>;
      deleted: string[];
      startedParams: JsonObject[];
      counter: number;
    },
  ): void {
    let buffer = "";
    official.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)) as JsonObject;
        buffer = buffer.slice(newline + 1);
        const method = String(message.method ?? "");
        const params = (message.params ?? {}) as JsonObject;
        let result: JsonObject = {};
        if (method === "thread/read") {
          const thread = state.threads.get(String(params.threadId));
          if (!thread) {
            if (message.id !== undefined) {
              official.stdout.write(
                `${JSON.stringify({ id: message.id, error: { code: -32000, message: "Not found" } })}\n`,
              );
            }
            continue;
          }
          result = { thread };
        } else if (method === "thread/start") {
          state.startedParams.push(params);
          state.counter += 1;
          const id = `official-handoff-${state.counter}`;
          const thread: JsonObject = {
            id,
            cwd: String(params.cwd ?? "/synthetic"),
            modelProvider: "openai",
            createdAt: 1000,
            updatedAt: 1000,
            status: { type: "idle" },
            turns: [],
          };
          state.threads.set(id, thread);
          result = { thread, model: typeof params.model === "string" ? params.model : "gpt-5.4" };
        } else if (method === "thread/inject_items") {
          state.injected.push({ threadId: String(params.threadId), items: params.items });
          result = {};
        } else if (method === "thread/name/set") {
          state.renamed.push({
            threadId: String(params.threadId),
            name: String(params.name ?? ""),
          });
          result = {};
        } else if (method === "thread/list") {
          result = { data: [], nextCursor: null };
        } else if (method === "thread/delete") {
          state.deleted.push(String(params.threadId));
          state.threads.delete(String(params.threadId));
          result = {};
        }
        if (message.id !== undefined) {
          official.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
        }
      }
    });
  }

  async function callDesktop(
    fixture: ReturnType<typeof createFixture>,
    id: number,
    method: string,
    params: JsonObject,
  ): Promise<JsonObject> {
    writeRequest(fixture.desktopInput, { id, method, params });
    return fixture.collector.waitFor((message) => requestId(message, id));
  }

  it("hands off External A -> External B, defers slash commands, strips prefix on replay, and exposes inspect metadata", async () => {
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const fixture = createFixture({
      externalAdapters: new Map([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    cleanups.push(() => stopFixture(fixture));

    const sourceId = await startExternalThread(fixture, "codexhost/pi-native", 1, {
      historyMode: "paginated",
    });
    await completePiTurn(fixture, sourceId, 2);

    const response = await callDesktop(fixture, 3, THREAD_HANDOFF_METHOD, {
      sourceThreadId: sourceId,
      targetHarnessId: "claude-code",
      targetModel: "fake-model-v1.primary",
      targetThinkingOptionId: "high",
    });
    const parsed = threadHandoffResultSchema.parse(response.result);
    expect(parsed.threadId).not.toBe(sourceId);
    expect(parsed.handoff.sourceThreadId).toBe(sourceId);
    expect(parsed.handoff.sourceHarnessId).toBe("pi");
    expect(parsed.handoff.targetHarnessId).toBe("claude-code");
    expect(parsed.handoff.includedTurnNumbers).toEqual([1]);
    expect(parsed.handoff.omittedTurns).toBe(0);
    expect(parsed.handoff.preview).toContain("<handoff_context>");
    expect(parsed.handoff.preview).toContain("synthetic");

    // Sidebar notification emitted for the newly created external handoff thread.
    await fixture.collector.waitFor(
      (message) =>
        message.method === "thread/started" &&
        ((message.params as JsonObject | undefined)?.thread as JsonObject | undefined)?.id ===
          parsed.threadId,
    );

    const targetSession = claudeAdapter.sessions[0];
    expect(targetSession).toBeDefined();
    if (!targetSession) return;

    const statusCommand = harnessCommandDescriptorSchema.parse({
      id: "claude.status",
      invocation: "/status",
      label: "Status",
      argumentMode: "none",
    });
    Object.assign(claudeAdapter, {
      commandCatalog: { commands: [statusCommand] },
      liveCommandCatalog: true,
    });
    const executedCommands: string[] = [];
    targetSession.commands = {
      list: async () => ({ ok: true, value: { commands: [statusCommand] } }),
      execute: async ({ turnId, commandId }) => {
        executedCommands.push(commandId);
        targetSession.publishEphemeralCommand(turnId, {
          itemId: hostItemIdSchema.parse("cmd-status-1"),
          type: "agentMessage",
          text: "status ok",
        });
        return { ok: true, value: { turnId } };
      },
    };

    // 1. Send a registered native slash command first — routed to #beginExternalCommand,
    //    so held handoff context stays pending for the next ordinary user turn.
    const slashStart = await callDesktop(fixture, 4, "turn/start", {
      threadId: parsed.threadId,
      input: [{ type: "text", text: "/status" }],
    });
    const slashTurnId = ((slashStart.result as JsonObject).turn as JsonObject).id as string;
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", slashTurnId));
    await vi.waitFor(() => {
      const idleAfterSlash = fixture.collector.messages
        .slice(
          fixture.collector.messages.findIndex((message) =>
            turnEvent(message, "turn/completed", slashTurnId),
          ) + 1,
        )
        .some((message) => threadStatus(message, parsed.threadId, "idle"));
      expect(idleAfterSlash).toBe(true);
    });
    expect(executedCommands).toEqual(["claude.status"]);

    // 2. Send an ordinary user message starting with a path like `/tmp ...` — must NOT be
    //    mistaken for a slash command; held handoff context leads this turn and strips on replay.
    const normalStart = await callDesktop(fixture, 5, "turn/start", {
      threadId: parsed.threadId,
      input: [{ type: "text", text: "/tmp 请检查这个目录" }],
    });
    expect(normalStart).not.toHaveProperty("error");
    const normalTurnId = ((normalStart.result as JsonObject).turn as JsonObject).id as string;
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", normalTurnId));
    targetSession.appendText("Checked /tmp");
    targetSession.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", normalTurnId),
    );

    const snap = await targetSession.readSnapshot();
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.value.turns.map((turn) => turn.input[0]?.text)).toEqual([
      `${parsed.handoff.preview}\n\n/tmp 请检查这个目录`,
    ]);

    // Replayed turn strips the injected handoff prefix so the user bubble stays clean.
    const listed = await callDesktop(fixture, 6, "thread/turns/list", {
      threadId: parsed.threadId,
      limit: 10,
      sortDirection: "asc",
      itemsView: "full",
    });
    const replayedTurns = (listed.result as JsonObject).data as JsonObject[];
    const normalUserItem = (replayedTurns[0]?.items as JsonObject[]).find(
      (item) => item.type === "userMessage",
    );
    expect(normalUserItem?.content).toMatchObject([{ type: "text", text: "/tmp 请检查这个目录" }]);

    // Inspect returns persisted handoff metadata.
    const inspected = await callDesktop(fixture, 7, "codexhost/thread/inspect", {
      threadId: parsed.threadId,
    });
    expect(threadInspectionSchema.parse(inspected.result)).toMatchObject({
      owner: "external",
      harnessId: "claude-code",
      handoff: parsed.handoff,
    });

    // Deleting the target thread cleans up persisted handoff metadata.
    await callDesktop(fixture, 8, "thread/delete", { threadId: parsed.threadId });
    expect(fixture.mappingStore.getThreadHandoff).toBeDefined();
    await expect(
      fixture.mappingStore.getThreadHandoff?.(hostThreadIdSchema.parse(parsed.threadId)),
    ).resolves.toBeNull();
  });

  it("supports External -> Codex, Codex -> External, Codex -> Codex, and cold inspect without waking Codex", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const fixture = createFixture({
      externalAdapters: new Map([["pi", piAdapter]]),
    });
    cleanups.push(() => stopFixture(fixture));

    const officialState = {
      threads: new Map<string, JsonObject>([
        [
          "official-source",
          {
            id: "official-source",
            cwd: "/official-workspace",
            name: "Official Plan Thread",
            modelProvider: "openai",
            model: "gpt-5.4",
            createdAt: 1000,
            updatedAt: 1001,
            status: { type: "idle" },
            turns: [
              makeTurn(1, "Design API contract", "Proposed schema v1"),
              makeTurn(2, "Review edge cases", "Verified timeout handling"),
            ],
          },
        ],
      ]),
      injected: [] as Array<{ threadId: string; items: unknown }>,
      renamed: [] as Array<{ threadId: string; name: string }>,
      deleted: [] as string[],
      startedParams: [] as JsonObject[],
      counter: 0,
    };
    attachOfficialResponder(fixture.official, officialState);

    // 1. External -> Codex
    const piSourceId = await startExternalThread(fixture, "codexhost/pi-native", 1, {
      historyMode: "paginated",
    });
    await completePiTurn(fixture, piSourceId, 2);

    const extToCodex = await callDesktop(fixture, 3, THREAD_HANDOFF_METHOD, {
      sourceThreadId: piSourceId,
      targetHarnessId: "codex",
      targetModel: "gpt-5.4",
      targetThinkingOptionId: "high",
    });
    const codexResult = threadHandoffResultSchema.parse(extToCodex.result);
    expect(codexResult.threadId).toBe("official-handoff-1");
    expect(codexResult.handoff.sourceHarnessId).toBe("pi");
    expect(codexResult.handoff.targetHarnessId).toBe("codex");
    expect(officialState.startedParams[0]).toMatchObject({
      cwd: "/synthetic",
      model: "gpt-5.4",
      config: { model_reasoning_effort: "high" },
      ephemeral: false,
      historyMode: "paginated",
    });
    expect(officialState.injected[0]).toEqual({
      threadId: "official-handoff-1",
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: codexResult.handoff.preview }],
        },
      ],
    });

    // 2. Codex -> External
    const codexToExt = await callDesktop(fixture, 4, THREAD_HANDOFF_METHOD, {
      sourceThreadId: "official-source",
      lastTurnId: "turn-1",
      targetHarnessId: "pi",
    });
    const piResult = threadHandoffResultSchema.parse(codexToExt.result);
    expect(piResult.handoff.sourceHarnessId).toBe("codex");
    expect(piResult.handoff.targetHarnessId).toBe("pi");
    expect(piResult.handoff.totalTurns).toBe(2);
    expect(piResult.handoff.boundaryTurnNumber).toBe(1);
    expect(piResult.handoff.includedTurnNumbers).toEqual([1]);
    expect(piResult.handoff.preview).toContain("Design API contract");
    expect(piResult.handoff.preview).not.toContain("Review edge cases");

    // 3. Codex -> Codex
    const codexToCodex = await callDesktop(fixture, 5, THREAD_HANDOFF_METHOD, {
      sourceThreadId: "official-source",
      targetHarnessId: "codex",
    });
    const c2cResult = threadHandoffResultSchema.parse(codexToCodex.result);
    expect(c2cResult.threadId).toBe("official-handoff-2");
    expect(c2cResult.handoff.sourceHarnessId).toBe("codex");
    expect(c2cResult.handoff.targetHarnessId).toBe("codex");
    expect(c2cResult.handoff.includedTurnNumbers).toEqual([1, 2]);
    expect(officialState.renamed).toContainEqual({
      threadId: "official-handoff-2",
      name: "Official Plan Thread",
    });

    // 4. Cold official inspect returns handoff metadata WITHOUT sending any RPC to official Codex!
    const officialWriteSpy = vi.fn();
    fixture.official.stdin.on("data", officialWriteSpy);
    const inspectColdOfficial = await callDesktop(fixture, 6, "codexhost/thread/inspect", {
      threadId: "official-handoff-1",
    });
    expect(threadInspectionSchema.parse(inspectColdOfficial.result)).toEqual({
      owner: "codex",
      locked: true,
      handoff: codexResult.handoff,
    });
    expect(officialWriteSpy).not.toHaveBeenCalled();

    // 5. ClientChannelHost snapshot & NativeClientChannel inspect also expose persisted handoff.
    const events = new ClientChannelEvents();
    const nativeRequest = vi.fn(async (method: string) => {
      if (method === "thread/read") {
        return {
          result: {
            thread: {
              id: "official-handoff-1",
              cwd: "/synthetic",
              modelProvider: "openai",
              createdAt: 1,
              updatedAt: 1,
              status: { type: "idle" },
              turns: [],
            },
          },
        };
      }
      if (method === "thread/turns/list" || method === "thread/queue/list") {
        return { result: { data: [], nextCursor: null } };
      }
      return { result: { model: "gpt-5.4" } };
    });
    const clientHost = new ClientChannelHost({
      events,
      environment: () => ({}),
      waitForPlugins: async () => {},
      listRecords: async () => [],
      listSectionPlacements: async () => [],
      locateExternalThread: async () => ({ kind: "official" }),
      loadedThread: () => undefined,
      clientHistoryTurns: () => [],
      queueSnapshot: () => ({ items: [], pausedReason: null }),
      readThreadHandoff: async (id) =>
        (await fixture.mappingStore.getThreadHandoff?.(hostThreadIdSchema.parse(id))) ?? null,
      interactions: {
        approvals: new Map(),
        questions: () => new Map(),
        isApprovalRequestId: (value): value is number => typeof value === "number",
        isQuestionRequestId: (value): value is number => typeof value === "number",
        respondApproval: async () => false,
        respondQuestion: async () => false,
      },
      native: {
        events,
        request: nativeRequest,
        respond: async () => {},
        readThreadHandoff: async (id) =>
          (await fixture.mappingStore.getThreadHandoff?.(hostThreadIdSchema.parse(id))) ?? null,
      },
      submit: async () => ({ result: {} }),
    });
    const clientInspect = await clientHost.handleClientRequest("codexhost/thread/inspect", {
      threadId: "official-handoff-1",
    });
    expect(clientInspect).toMatchObject({
      result: { owner: "codex", locked: false, handoff: codexResult.handoff },
    });
    const clientSnap = await clientHost.clientSnapshot("official-handoff-1");
    expect(clientSnap.handoff).toEqual(codexResult.handoff);
  });

  it("announces official handoff thread/started and exposes official handoff metadata across SharedThreadBridge", async () => {
    const sharedDir = mkdtempSync(path.join(tmpdir(), "shared-handoff-owner-"));
    const owner = new SharedThreadOwner();
    const sharedPiAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const sharedOfficial = new FakeOfficialProcess();
    const sharedOfficialState = {
      threads: new Map<string, JsonObject>(),
      injected: [] as Array<{ threadId: string; items: unknown }>,
      renamed: [] as Array<{ threadId: string; name: string }>,
      deleted: [] as string[],
      startedParams: [] as JsonObject[],
      counter: 0,
    };
    attachOfficialResponder(sharedOfficial, sharedOfficialState);
    const sharedHost = new AppServerHost({
      stockCodexPath: "/unused",
      arguments: [],
      externalOnly: true,
      environment: {
        HOME: sharedDir,
        CODEX_HOME: path.join(sharedDir, "codex"),
        CODEXHOST_DATA_DIR: sharedDir,
      },
      desktopInput: owner.input,
      desktopOutput: owner.output,
      diagnosticOutput: new PassThrough(),
      mappingStore: new MappingStore({ directory: sharedDir }),
      externalAdapters: new Map([["pi", sharedPiAdapter]]),
      spawnOfficial: (() => sharedOfficial) as unknown as typeof spawn,
      officialCloseTimeoutMs: 50,
    });
    const sharedRun = sharedHost.run();
    cleanups.push(async () => {
      sharedHost.close();
      await sharedRun;
      owner.close();
      owner.output.end();
      rmSync(sharedDir, { recursive: true, force: true });
    });

    let allowConnect = true;
    const bridge = new SharedThreadBridge({
      connect: async () => (allowConnect ? owner.connect() : null),
      delegateCreates: true,
      diagnose: () => undefined,
    });
    const gui = createFixture({ sharedThreads: bridge });
    cleanups.push(() => stopFixture(gui));

    const guiOfficialReads: JsonObject[] = [];
    let guiBuf = "";
    gui.official.stdin.on("data", (chunk: Buffer) => {
      guiBuf += chunk.toString();
      let nl: number;
      while ((nl = guiBuf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(guiBuf.slice(0, nl)) as JsonObject;
        guiBuf = guiBuf.slice(nl + 1);
        if (msg.method === "thread/read") guiOfficialReads.push(msg);
        if (msg.id !== undefined) {
          gui.official.stdout.write(
            `${JSON.stringify({ id: msg.id, result: { thread: { id: (msg.params as JsonObject | undefined)?.threadId ?? "official" } } })}\n`,
          );
        }
      }
    });

    // Create a shared external Pi thread through the Desktop GUI and complete one turn.
    const sourceId = await startExternalThread(gui, "codexhost/pi-native", 1, {
      historyMode: "paginated",
    });
    const turnStart = await callDesktop(gui, 2, "turn/start", {
      threadId: sourceId,
      input: [{ type: "text", text: "Summarize shared state" }],
    });
    const turnId = ((turnStart.result as JsonObject).turn as JsonObject).id as string;
    await gui.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const piSession = sharedPiAdapter.sessions[0];
    if (!piSession) throw new Error("Expected shared Pi session");
    piSession.appendText("Shared state ready");
    piSession.succeedTurn();
    await gui.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

    // Hand off External -> Official Codex via Shared Host.
    const handoffReply = await callDesktop(gui, 3, THREAD_HANDOFF_METHOD, {
      sourceThreadId: sourceId,
      targetHarnessId: "codex",
      targetModel: "gpt-5.4",
    });
    const handoffResult = threadHandoffResultSchema.parse(handoffReply.result);
    expect(handoffResult.threadId).toBe("official-handoff-1");

    // Desktop GUI must receive thread/started for the new official thread so sidebar opens it.
    const startedEvent = await gui.collector.waitFor(
      (message) =>
        message.method === "thread/started" &&
        ((message.params as JsonObject | undefined)?.thread as JsonObject | undefined)?.id ===
          handoffResult.threadId,
    );
    expect(((startedEvent.params as JsonObject).thread as JsonObject).modelProvider).toBe("openai");

    // The official Codex thread must NOT be misclassified as a shared external thread.
    expect(bridge.knowsTreeOwner(handoffResult.threadId)).toBe(false);
    await callDesktop(gui, 4, "thread/read", {
      threadId: handoffResult.threadId,
      includeTurns: false,
    });
    expect(guiOfficialReads.map((m) => (m.params as JsonObject | undefined)?.threadId)).toContain(
      handoffResult.threadId,
    );

    // Inspecting the official thread on GUI (separate MappingStore) must retrieve handoff from Shared Host without waking GUI official Codex.
    const guiWriteSpy = vi.fn();
    gui.official.stdin.on("data", guiWriteSpy);
    const inspected = await callDesktop(gui, 5, "codexhost/thread/inspect", {
      threadId: handoffResult.threadId,
    });
    expect(threadInspectionSchema.parse(inspected.result)).toEqual({
      owner: "codex",
      locked: true,
      handoff: handoffResult.handoff,
    });
    expect(guiWriteSpy).not.toHaveBeenCalled();

    // If Shared Host goes offline, official inspect degrades gracefully without failing.
    allowConnect = false;
    bridge.close();
    const offlineInspected = await callDesktop(gui, 6, "codexhost/thread/inspect", {
      threadId: handoffResult.threadId,
    });
    expect(threadInspectionSchema.parse(offlineInspected.result)).toEqual({
      owner: "codex",
      locked: true,
    });
  });

  it("keeps deferred-nativeRef external handoff targets visible in thread/list, survives Host restart before Turn 1, and binds nativeRef on first turn", async () => {
    const storeDir = mkdtempSync(path.join(tmpdir(), "deferred-handoff-restart-"));
    cleanups.push(() => rmSync(storeDir, { recursive: true, force: true }));

    function createDeferredClaudeAdapter() {
      const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
      const baseOpen = adapter.open.bind(adapter);
      adapter.open = async (input) => {
        const opened = await baseOpen(input);
        if (!opened.ok || input.kind !== "create") return opened;
        const session = opened.value as FakeHarnessSession;
        const deferredRef = session.initialState.nativeRef;
        delete session.initialState.nativeRef;
        const baseExecute = session.execute.bind(session) as unknown as (command: {
          type: string;
        }) => Promise<unknown>;
        let bound = false;
        session.execute = (async (command: { type: string }) => {
          if (command.type === "turn.start" && !bound && deferredRef) {
            bound = true;
            session.setStateForSnapshot({ ...session.state, nativeRef: deferredRef });
            session.emitEvent({
              type: "session.state.changed",
              state: { nativeRef: deferredRef },
            });
          }
          return baseExecute(command);
        }) as unknown as FakeHarnessSession["execute"];
        return opened;
      };
      return adapter;
    }

    const piAdapter1 = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter1 = createDeferredClaudeAdapter();
    const fixture1 = createFixture({
      mappingStoreDirectory: storeDir,
      externalAdapters: new Map([
        ["pi", piAdapter1],
        ["claude-code", claudeAdapter1],
      ]),
    });
    attachOfficialResponder(fixture1.official, {
      threads: new Map(),
      injected: [],
      renamed: [],
      deleted: [],
      startedParams: [],
      counter: 0,
    });

    const sourceId = await startExternalThread(fixture1, "codexhost/pi-native", 1, {
      historyMode: "paginated",
    });
    await completePiTurn(fixture1, sourceId, 2);

    const handoffReply = await callDesktop(fixture1, 3, THREAD_HANDOFF_METHOD, {
      sourceThreadId: sourceId,
      targetHarnessId: "claude-code",
    });
    const handedOff = threadHandoffResultSchema.parse(handoffReply.result);

    // Target must remain in creating state (no nativeRef yet), yet immediately appear in thread/list.
    const storedBeforeRestart = await fixture1.mappingStore.getThread(handedOff.threadId);
    expect(storedBeforeRestart?.state).toBe("creating");
    expect(storedBeforeRestart?.nativeSessionRef).toBeUndefined();
    expect(storedBeforeRestart?.pendingInjectedText?.length).toBe(1);

    const listBeforeRestart = await callDesktop(fixture1, 4, "thread/list", {});
    const listedIdsBefore = ((listBeforeRestart.result as JsonObject).data as JsonObject[]).map(
      (row) => row.id,
    );
    expect(listedIdsBefore).toContain(handedOff.threadId);

    // Close Host #1 (preserving disk store) before any Turn is sent, then boot Host #2 on the same store.
    await closeFixture(fixture1);

    const piAdapter2 = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter2 = createDeferredClaudeAdapter();
    const fixture2 = createFixture({
      mappingStoreDirectory: storeDir,
      externalAdapters: new Map([
        ["pi", piAdapter2],
        ["claude-code", claudeAdapter2],
      ]),
    });
    cleanups.push(() => stopFixture(fixture2));
    attachOfficialResponder(fixture2.official, {
      threads: new Map(),
      injected: [],
      renamed: [],
      deleted: [],
      startedParams: [],
      counter: 0,
    });

    // After restart, the deferred target survived MappingStore.initialize(), stays in thread/list,
    // and cold-inspects its handoff metadata without waking the adapter.
    const listAfterRestart = await callDesktop(fixture2, 10, "thread/list", {});
    const listedIdsAfter = ((listAfterRestart.result as JsonObject).data as JsonObject[]).map(
      (row) => row.id,
    );
    expect(listedIdsAfter).toContain(handedOff.threadId);

    const coldInspect = await callDesktop(fixture2, 11, "codexhost/thread/inspect", {
      threadId: handedOff.threadId,
    });
    expect(threadInspectionSchema.parse(coldInspect.result)).toMatchObject({
      owner: "external",
      harnessId: "claude-code",
      handoff: handedOff.handoff,
    });
    expect(claudeAdapter2.sessions).toHaveLength(0);

    // Opening the cold deferred thread lazily creates the native session and lists empty turns.
    const coldTurns = await callDesktop(fixture2, 12, "thread/turns/list", {
      threadId: handedOff.threadId,
      limit: 5,
    });
    expect(coldTurns.result).toMatchObject({ data: [], nextCursor: null });
    expect(claudeAdapter2.sessions).toHaveLength(1);

    // Sending the first turn injects handoff context, binds nativeRef, and promotes state to ready.
    const firstTurnReply = await callDesktop(fixture2, 13, "turn/start", {
      threadId: handedOff.threadId,
      input: [{ type: "text", text: "/tmp check handoff" }],
    });
    const firstTurnId = ((firstTurnReply.result as JsonObject).turn as JsonObject).id as string;
    await fixture2.collector.waitFor((message) => turnEvent(message, "turn/started", firstTurnId));
    const liveSession = claudeAdapter2.sessions[0];
    if (!liveSession) throw new Error("Expected lazily created deferred session");
    liveSession.appendText("Got handoff");
    liveSession.succeedTurn();
    await fixture2.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", firstTurnId),
    );

    const storedAfterTurn = await fixture2.mappingStore.getThread(handedOff.threadId);
    expect(storedAfterTurn?.state).toBe("ready");
    expect(storedAfterTurn?.nativeSessionRef).toBeDefined();
    expect(storedAfterTurn?.pendingInjectedText).toBeUndefined();

    const snapAfterTurn = await liveSession.readSnapshot();
    expect(snapAfterTurn.ok).toBe(true);
    if (snapAfterTurn.ok) {
      expect(snapAfterTurn.value.turns[0]?.input[0]?.text).toBe(
        `${handedOff.handoff.preview}\n\n/tmp check handoff`,
      );
    }
  });

  it("does not leak an in-progress turn's livePlan when lastTurnId is omitted", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    cleanups.push(() => stopFixture(fixture));

    const sourceId = await startExternalThread(fixture, "codexhost/pi-native", 1, {
      historyMode: "paginated",
    });
    await completePiTurn(fixture, sourceId, 2);

    // Start a second turn that stays inProgress and emits a live plan update.
    const inProgressStart = await callDesktop(fixture, 3, "turn/start", {
      threadId: sourceId,
      input: [{ type: "text", text: "In-progress step" }],
    });
    const inProgressTurnId = ((inProgressStart.result as JsonObject).turn as JsonObject)
      .id as string;
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/started", inProgressTurnId),
    );
    const piSession = piAdapter.sessions[0];
    if (!piSession) throw new Error("Expected Pi session");
    piSession.completeItem(
      piSession.startToolExecution("Todo", {
        todos: [{ content: "Do not leak this step", status: "in_progress" }],
      }),
      { status: "succeeded" },
    );
    await fixture.collector.waitFor((message) => message.method === "turn/plan/updated");

    // Handoff without explicit lastTurnId must cut at Turn 1 and NOT leak Turn 2's livePlan.
    const handoffReply = await callDesktop(fixture, 4, THREAD_HANDOFF_METHOD, {
      sourceThreadId: sourceId,
      targetHarnessId: "claude-code",
    });
    const handedOff = threadHandoffResultSchema.parse(handoffReply.result);
    expect(handedOff.handoff.boundaryTurnNumber).toBe(1);
    expect(handedOff.handoff.preview).not.toContain("Do not leak this step");
  });

  it("routes codexhost/thread/handoff by params.sourceThreadId when SharedThreadBridge has delegateCreates=false", async () => {
    const sharedSourceId = "01984de2-8f74-7c91-a3b2-5c5e937cf319";
    const localOfficialId = "01984de2-8f74-7c91-a3b2-5c5e937cf320";
    const forwarded: Array<{ method: string; params: JsonObject }> = [];
    const ended = Promise.withResolvers<undefined>();
    const peer: SharedThreadPeer = {
      request: async (method, params) => {
        if (method === "codexhost/thread/ownership/list") {
          const ids = Array.isArray(params.threadIds) ? params.threadIds : [];
          return {
            result: {
              threads: ids.map((id) =>
                id === sharedSourceId
                  ? { threadId: id, owner: "external", harnessId: "pi" }
                  : { threadId: id, owner: "codex" },
              ),
            },
          };
        }
        forwarded.push({ method, params });
        return { result: { threadId: "new-shared-target" } };
      },
      respond: async () => undefined,
      subscribe: () => () => undefined,
      closed: ended.promise,
      close: () => ended.resolve(undefined),
    };
    const bridge = new SharedThreadBridge({
      connect: async () => peer,
      delegateCreates: false,
      diagnose: () => undefined,
    });
    cleanups.push(() => bridge.close());

    const routedShared = await bridge.route({
      id: 1,
      method: THREAD_HANDOFF_METHOD,
      params: { sourceThreadId: sharedSourceId, targetHarnessId: "claude-code" },
    });
    expect(routedShared).toEqual({ id: 1, result: { threadId: "new-shared-target" } });
    expect(forwarded).toHaveLength(1);

    const routedOfficial = await bridge.route({
      id: 2,
      method: THREAD_HANDOFF_METHOD,
      params: { sourceThreadId: localOfficialId, targetHarnessId: "claude-code" },
    });
    expect(routedOfficial).toBeNull();
    expect(forwarded).toHaveLength(1);
  });
});
