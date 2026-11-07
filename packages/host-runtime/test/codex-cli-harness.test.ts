import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  encodeHarnessPluginRoute,
  harnessPluginIdSchema,
  type ClientThreadSnapshot,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHarnessAdapter } from "@codexhost/adapter-codex-cli/plugin";
import { HostClientChannel } from "@codexhost/desktop-control";

import { createFixture, stopFixture, writeRequest } from "./app-server-host-fixture.js";
import { startClientChannelServer } from "../src/client-channel-server.js";

const roots: string[] = [];
afterEach(() => {
  // On Windows the cmd.exe-launched CLI may still hold the directory; CI discards it.
  for (const root of roots.splice(0))
    if (process.platform !== "win32") rmSync(root, { recursive: true, force: true });
});

const CODEX_CLI = harnessPluginIdSchema.parse("codex-cli");

function codexCliFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-cli-runtime-")));
  roots.push(root);
  const home = join(root, ".codex");
  mkdirSync(home);
  const command = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
  const peer = process.platform === "win32" ? join(root, "codex-peer.cjs") : command;
  writeFileSync(
    peer,
    `#!${process.execPath}\nprocess.stdin.on('end', () => process.exit(0));\n${readFileSync(resolve("tests/fixtures/codex-auth-peer.cjs"), "utf8")}`,
  );
  if (process.platform === "win32") {
    writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0codex-peer.cjs" %*\r\n`);
  } else {
    chmodSync(command, 0o700);
  }
  const scenario = (value: JsonObject) =>
    writeFileSync(join(home, "scenario.json"), JSON.stringify(value));
  scenario({});
  const refreshNativeThreadCatalog = vi.fn<(nativeHome: string) => Promise<void>>(
    async () => undefined,
  );
  const adapter = createHarnessAdapter({
    platform: process.platform,
    managedRemoteHost: false,
    launchCommand: command,
    environment: { HOME: root, CODEX_HOME: home },
    refreshNativeThreadCatalog,
  });
  const fixture = createFixture({
    additionalAdapters: new Map([[CODEX_CLI, adapter]]),
  });
  return { root, home, adapter, fixture, scenario, refreshNativeThreadCatalog };
}

async function callClient(
  fixture: ReturnType<typeof createFixture>,
  method: string,
  params: JsonObject,
): Promise<JsonObject> {
  const reply = await fixture.host.handleClientRequest(method, params);
  if ("error" in reply) throw new Error(reply.error.message);
  return reply.result as JsonObject;
}

async function waitForSnapshot(
  fixture: ReturnType<typeof createFixture>,
  threadId: string,
  accept: (snapshot: ClientThreadSnapshot) => boolean,
): Promise<ClientThreadSnapshot> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const snapshot = await fixture.host.clientSnapshot(threadId);
    if (accept(snapshot)) return snapshot;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("Timed out waiting for the client Thread snapshot");
}

function activeTurnOf(turn: JsonObject): string {
  const value = (turn.turn as JsonObject | undefined)?.id;
  if (typeof value !== "string") throw new Error("Turn start returned no Turn id");
  return value;
}

describe("Codex CLI through the external Thread runtime", () => {
  it("imports one logical Session from multiple native segments, reads its history and continues the same identity", async () => {
    const { home, adapter, fixture, scenario, refreshNativeThreadCatalog } = codexCliFixture();
    const original = {
      id: "logical-import",
      name: "Old segment",
      preview: "earlier",
      cwd: home,
      updatedAt: 1_700_000_000,
      ephemeral: false,
      parentThreadId: null,
    };
    const continuation = { ...original, name: "Segment listing title", updatedAt: 1_700_000_100 };
    const canonical = {
      ...original,
      name: "Canonical native conversation",
      updatedAt: 1_700_000_050,
    };
    scenario({
      threads: [continuation, original],
      threadReads: { "logical-import": canonical },
      threadTurns: {
        "logical-import": [
          {
            id: "before-continuation",
            status: "completed",
            items: [
              {
                id: "old-user",
                type: "userMessage",
                content: [{ type: "text", text: "Before the continuation" }],
              },
              { id: "old-answer", type: "agentMessage", text: "Original native answer" },
            ],
            startedAt: 1,
            completedAt: 2,
            error: null,
          },
          {
            id: "after-continuation",
            status: "completed",
            items: [
              {
                id: "new-user",
                type: "userMessage",
                content: [{ type: "text", text: "After the continuation" }],
              },
              { id: "new-answer", type: "agentMessage", text: "Continuation native answer" },
            ],
            startedAt: 3,
            completedAt: 4,
            error: null,
          },
        ],
      },
    });
    try {
      const listed = await callClient(fixture, "codexhost/harness/session-import/list", {
        harnessId: CODEX_CLI,
      });
      expect(listed).toMatchObject({
        total: 1,
        candidates: [
          {
            nativeSessionId: "logical-import",
            title: "Canonical native conversation",
            cwd: home,
            updatedAt: 1_700_000_050_000,
          },
        ],
      });
      const imported = await callClient(fixture, "codexhost/harness/session-import/import", {
        harnessId: CODEX_CLI,
        nativeSessionId: "logical-import",
      });
      const threadId = String(imported.threadId);
      expect(
        await callClient(fixture, "codexhost/harness/session-import/import", {
          harnessId: CODEX_CLI,
          nativeSessionId: "logical-import",
        }),
      ).toEqual(imported);
      const beforeOpen = readFileSync(join(home, "rpc.jsonl"), "utf8");
      expect(beforeOpen).toContain('"method":"thread/resume"');
      expect(beforeOpen).not.toContain('"method":"thread/fork"');
      expect(beforeOpen).not.toContain('"method":"turn/start"');
      const history = await callClient(fixture, "thread/turns/list", { threadId, limit: 100 });
      expect(history.data).toHaveLength(2);
      expect(JSON.stringify(history)).toContain("Original native answer");
      expect(JSON.stringify(history)).toContain("Continuation native answer");
      expect(
        await callClient(fixture, "codexhost/harness/session-import/list", {
          harnessId: CODEX_CLI,
        }),
      ).toMatchObject({ candidates: [], total: 0 });
      const turn = await callClient(fixture, "turn/start", {
        threadId,
        clientUserMessageId: "continue-imported",
        input: [{ type: "text", text: "Continue this native conversation" }],
      });
      const turnId = activeTurnOf(turn);
      await waitForSnapshot(
        fixture,
        threadId,
        (snapshot) =>
          snapshot.activeTurnId !== turnId &&
          snapshot.turnsPage.data.some((entry) => entry.id === turnId),
      );
      const updated = await callClient(fixture, "thread/turns/list", { threadId, limit: 100 });
      expect(updated.data).toHaveLength(3);
      expect(JSON.stringify(updated)).toContain("Original native answer");
      expect(JSON.stringify(updated)).toContain("Continuation native answer");
      const records = readFileSync(join(home, "rpc.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; params: { threadId?: string } });
      expect(records.some((entry) => entry.method === "thread/start")).toBe(false);
      expect(
        records
          .filter((entry) => entry.method === "thread/resume")
          .every((entry) => entry.params.threadId === "logical-import"),
      ).toBe(true);
      expect(records.find((entry) => entry.method === "turn/start")?.params.threadId).toBe(
        "logical-import",
      );
      expect(refreshNativeThreadCatalog).not.toHaveBeenCalled();
    } finally {
      await stopFixture(fixture);
      await adapter.close();
    }
  });

  it("forks a busy import at its completed Turn, keeps its new identity and continues independently", async () => {
    const { root, home, adapter, fixture, scenario, refreshNativeThreadCatalog } =
      codexCliFixture();
    const nativeThread = {
      id: "busy-import",
      name: "Imported conversation",
      cwd: home,
      updatedAt: 1_700_000_000,
      ephemeral: false,
      parentThreadId: null,
    };
    const nativeHistory = {
      threads: [nativeThread],
      threadTurns: {
        "busy-import": [
          {
            id: "original-turn",
            status: "completed",
            items: [{ id: "original-answer", type: "agentMessage", text: "Saved native answer" }],
            error: null,
          },
          {
            id: "active-source-turn",
            status: "inProgress",
            items: [
              { id: "partial-answer", type: "agentMessage", text: "Unfinished source answer" },
            ],
            error: null,
          },
        ],
      },
    };
    scenario({
      ...nativeHistory,
      resumeError: { code: -32600, message: "thread busy-import already has an active writer" },
    });
    await fixture.ready;
    const directory = join(root, "client-hosts");
    const server = await startClientChannelServer({
      target: fixture.host,
      environment: {},
      directory,
    });
    const channel = new HostClientChannel(directory, server.descriptor);
    try {
      await channel.start();
      const imported = await channel.request<{ threadId: string }>(
        "codexhost/harness/session-import/import",
        { harnessId: CODEX_CLI, nativeSessionId: nativeThread.id },
      );
      const snapshot = await channel.snapshot(imported.threadId);
      expect(snapshot.thread.id).toBe(imported.threadId);
      expect(JSON.stringify(snapshot.turnsPage)).toContain("Saved native answer");
      expect(JSON.stringify(snapshot.turnsPage)).not.toContain("Unfinished source answer");
      expect(snapshot.thread.codexhostImportSource).toEqual({
        harnessId: CODEX_CLI,
        nativeSessionId: nativeThread.id,
      });
      expect(
        await channel.request("codexhost/harness/session-import/import", {
          harnessId: CODEX_CLI,
          nativeSessionId: nativeThread.id,
        }),
      ).toEqual(imported);
      expect((await channel.snapshot(imported.threadId)).thread.id).toBe(imported.threadId);
      const turn = await callClient(fixture, "turn/start", {
        threadId: imported.threadId,
        clientUserMessageId: "continue-busy-import",
        input: [{ type: "text", text: "Continue independently" }],
      });
      const turnId = activeTurnOf(turn);
      await waitForSnapshot(
        fixture,
        imported.threadId,
        (snapshot) =>
          snapshot.activeTurnId !== turnId &&
          snapshot.turnsPage.data.some((entry) => entry.id === turnId),
      );
      const requests = readFileSync(join(home, "rpc.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method: string;
              params: { threadId?: string; lastTurnId?: string };
            },
        );
      expect(requests.some(({ method }) => method === "thread/start")).toBe(false);
      const forks = requests.filter(({ method }) => method === "thread/fork");
      expect(forks).toHaveLength(1);
      expect(forks[0]?.params).toMatchObject({
        threadId: nativeThread.id,
        lastTurnId: "original-turn",
      });
      expect(requests.find(({ method }) => method === "turn/start")?.params.threadId).toMatch(
        /^native-fork-/u,
      );
      expect(
        requests
          .filter(({ method }) => method === "thread/resume")
          .map(({ params }) => params.threadId),
      ).toEqual([nativeThread.id]);
      expect(refreshNativeThreadCatalog).toHaveBeenCalledExactlyOnceWith(home);
    } finally {
      channel.close();
      await server.close();
      await stopFixture(fixture);
      await adapter.close();
    }
  });

  it("exposes native account quota through the shared usage and account routes", async () => {
    const { root, adapter, fixture, scenario } = codexCliFixture();
    scenario({
      accountRead: {
        account: { type: "chatgpt", email: "codex@example.com", planType: "plus" },
        requiresOpenaiAuth: true,
      },
      rateLimits: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 25, windowDurationMins: 300 },
          secondary: { usedPercent: 40, windowDurationMins: 10_080 },
        },
      },
    });
    try {
      await fixture.ready;
      const created = await callClient(fixture, "thread/start", {
        model: encodeHarnessPluginRoute({ harnessId: CODEX_CLI }),
        cwd: root,
      });
      const threadId = String((created.thread as JsonObject).id);
      const usage = () => callClient(fixture, "codexhost/thread/usage/inspect", { threadId });
      expect(await usage()).toMatchObject({ accountCreditsSupported: true });
      await expect
        .poll(async () => (await usage()).accountCredits)
        .toMatchObject({
          usedPercent: 25,
          periodType: "five_hour",
          productUsage: [{ periodType: "seven_day", usagePercent: 40 }],
        });
      writeRequest(fixture.desktopInput, {
        id: 991,
        method: "codexhost/harness/accounts/inspect",
        params: { harnessId: CODEX_CLI },
      });
      expect(await fixture.collector.waitFor((message) => message.id === 991)).toMatchObject({
        result: {
          account: { email: "codex@example.com", plan: "plus", credits: { usedPercent: 25 } },
        },
      });
    } finally {
      await stopFixture(fixture);
      await adapter.close();
    }
  });

  it("creates, asks for approval, answers a question, cancels and resumes", async () => {
    const { root, adapter, fixture, home, scenario } = codexCliFixture();
    try {
      await fixture.ready;
      const created = await callClient(fixture, "thread/start", {
        model: encodeHarnessPluginRoute({ harnessId: CODEX_CLI }),
        cwd: root,
      });
      const threadId = String((created.thread as JsonObject).id);
      expect(threadId).not.toBe("");

      scenario({ approval: true });
      const first = await callClient(fixture, "turn/start", {
        threadId,
        clientUserMessageId: "message-1",
        input: [{ type: "text", text: "inspect" }],
      });
      const firstTurnId = activeTurnOf(first);
      const approval = await waitForSnapshot(
        fixture,
        threadId,
        (snapshot) => snapshot.interactions.length > 0,
      );
      expect(approval.interactions[0]).toMatchObject({ kind: "approval" });
      await fixture.host.respondClient({
        epoch: fixture.host.clientEvents.epoch,
        threadId,
        requestId: approval.interactions[0]?.requestId as number,
        result: { action: "accept" },
      });
      await waitForSnapshot(
        fixture,
        threadId,
        (snapshot) =>
          snapshot.activeTurnId !== firstTurnId &&
          snapshot.turnsPage.data.some((turn) => turn.id === firstTurnId),
      );

      scenario({ question: true });
      const second = await callClient(fixture, "turn/start", {
        threadId,
        clientUserMessageId: "message-2",
        input: [{ type: "text", text: "ask" }],
      });
      const secondTurnId = activeTurnOf(second);
      const question = await waitForSnapshot(fixture, threadId, (snapshot) =>
        snapshot.interactions.some((entry) => entry.kind === "question"),
      );
      const pending = question.interactions.find((entry) => entry.kind === "question");
      expect(JSON.stringify(pending?.request)).toContain("Continue?");
      await fixture.host.respondClient({
        epoch: fixture.host.clientEvents.epoch,
        threadId,
        requestId: pending?.requestId as number,
        result: { answers: { "question-1": { answers: ["yes"] } } },
      });
      await waitForSnapshot(
        fixture,
        threadId,
        (snapshot) =>
          snapshot.activeTurnId !== secondTurnId &&
          snapshot.turnsPage.data.some((turn) => turn.id === secondTurnId),
      );

      scenario({ turnDelay: 30_000 });
      const third = await callClient(fixture, "turn/start", {
        threadId,
        clientUserMessageId: "message-3",
        input: [{ type: "text", text: "long" }],
      });
      const thirdTurnId = activeTurnOf(third);
      await waitForSnapshot(fixture, threadId, (snapshot) => snapshot.activeTurnId === thirdTurnId);
      await callClient(fixture, "turn/interrupt", { threadId, turnId: thirdTurnId });
      await waitForSnapshot(
        fixture,
        threadId,
        (snapshot) =>
          snapshot.activeTurnId !== thirdTurnId &&
          snapshot.turnsPage.data.some(
            (turn) => turn.id === thirdTurnId && turn.status === "interrupted",
          ),
      );

      scenario({
        threads: [
          {
            id: "native-imported",
            name: "Imported",
            preview: "hello",
            cwd: home,
            updatedAt: 1_700_000_000,
            ephemeral: false,
            parentThreadId: null,
          },
        ],
        unsavedTurns: true,
      });
      const listed = await callClient(fixture, "codexhost/harness/session-import/list", {
        harnessId: CODEX_CLI,
      });
      expect(listed).toMatchObject({
        candidates: [{ nativeSessionId: "native-imported", title: "Imported" }],
      });
      const imported = await callClient(fixture, "codexhost/harness/session-import/import", {
        harnessId: CODEX_CLI,
        nativeSessionId: "native-imported",
      });
      const importedThreadId = String(imported.threadId);
      expect(importedThreadId).not.toBe("");
      const page = await callClient(fixture, "thread/turns/list", {
        threadId: importedThreadId,
      });
      expect(page).toMatchObject({ data: [] });
      const resumed = readFileSync(join(home, "rpc.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; params: { threadId?: string } })
        .filter(({ method }) => method === "thread/resume");
      expect(resumed.some(({ params }) => params.threadId === "native-imported")).toBe(true);
    } finally {
      await stopFixture(fixture);
      await adapter.close();
    }
  });
});
