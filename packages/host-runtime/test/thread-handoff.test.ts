import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  REASONING_TRANSCRIPT_COMMAND,
  THREAD_HANDOFF_METHOD,
  harnessIdSchema,
  hostThreadIdSchema,
  threadHandoffResultSchema,
  threadInspectionSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientChannelEvents } from "../src/client-channel-events.js";
import { ClientChannelHost } from "../src/client-channel-host.js";
import { isSlashCommandInput, withInjectedText } from "../src/external-thread-side-chat.js";
import {
  MAX_HANDOFF_BYTES,
  buildThreadHandoffPackage,
  cutEndUtf8,
  cutStartUtf8,
  utf8ByteLength,
} from "../src/thread-handoff.js";
import {
  completePiTurn,
  createFixture,
  requestId,
  startExternalThread,
  stopFixture,
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

  it("defers pendingInjectedText for slash commands but not for file paths", () => {
    expect(isSlashCommandInput("/compact")).toBe(true);
    expect(isSlashCommandInput("  /status now")).toBe(true);
    expect(isSlashCommandInput("/foo/bar")).toBe(false);
    expect(isSlashCommandInput("/Users/dev/app.ts please edit")).toBe(false);
    expect(isSlashCommandInput("please run /compact")).toBe(false);

    const held = { pendingInjectedText: ["<handoff_context>ctx</handoff_context>"] };
    const deferred = withInjectedText(held, "/compact");
    expect(deferred.text).toBe("/compact");
    expect(deferred.prefix).toBeUndefined();

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

    // 1. Send a slash command first — handoff context must be deferred, not prepended.
    const slashStart = await callDesktop(fixture, 4, "turn/start", {
      threadId: parsed.threadId,
      input: [{ type: "text", text: "/status" }],
    });
    const slashTurnId = ((slashStart.result as JsonObject).turn as JsonObject).id as string;
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", slashTurnId));
    targetSession.appendText("status ok");
    targetSession.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", slashTurnId));

    // 2. Send an ordinary user message — held handoff context must lead this turn and be stripped on replay.
    const normalStart = await callDesktop(fixture, 5, "turn/start", {
      threadId: parsed.threadId,
      input: [{ type: "text", text: "Continue the refactor" }],
    });
    const normalTurnId = ((normalStart.result as JsonObject).turn as JsonObject).id as string;
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", normalTurnId));
    targetSession.appendText("Continuing now");
    targetSession.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", normalTurnId),
    );

    const snap = await targetSession.readSnapshot();
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.value.turns.map((turn) => turn.input[0]?.text)).toEqual([
      "/status",
      `${parsed.handoff.preview}\n\nContinue the refactor`,
    ]);

    // Replayed turns strip the injected handoff prefix so the user bubble stays clean.
    const listed = await callDesktop(fixture, 6, "thread/turns/list", {
      threadId: parsed.threadId,
      limit: 10,
      sortDirection: "asc",
      itemsView: "full",
    });
    const replayedTurns = (listed.result as JsonObject).data as JsonObject[];
    const slashUserItem = (replayedTurns[0]?.items as JsonObject[]).find(
      (item) => item.type === "userMessage",
    );
    const normalUserItem = (replayedTurns[1]?.items as JsonObject[]).find(
      (item) => item.type === "userMessage",
    );
    expect(slashUserItem?.content).toMatchObject([{ type: "text", text: "/status" }]);
    expect(normalUserItem?.content).toMatchObject([
      { type: "text", text: "Continue the refactor" },
    ]);

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
    await expect(
      fixture.mappingStore.getThreadHandoff(hostThreadIdSchema.parse(parsed.threadId)),
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
      readThreadHandoff: (id) =>
        fixture.mappingStore.getThreadHandoff(hostThreadIdSchema.parse(id)),
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
        readThreadHandoff: (id) =>
          fixture.mappingStore.getThreadHandoff(hostThreadIdSchema.parse(id)),
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
});
