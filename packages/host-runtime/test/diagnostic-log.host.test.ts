import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeFixture,
  completePiTurn,
  createFixture,
  requestId,
  startPiThread,
  writeRequest,
} from "./app-server-host-fixture.js";

const fixtures: ReturnType<typeof createFixture>[] = [];

function host(environment: NodeJS.ProcessEnv = {}): ReturnType<typeof createFixture> {
  const fixture = createFixture({ environment });
  fixtures.push(fixture);
  return fixture;
}

function messageTurnId(message: Record<string, unknown>): string | undefined {
  const params = (message.params ?? {}) as Record<string, unknown>;
  const turn = params.turn as Record<string, unknown> | undefined;
  return (turn?.id ?? params.turnId) as string | undefined;
}

function logDirectory(fixture: ReturnType<typeof createFixture>): string {
  return path.join(fixture.mappingStoreDirectory, "logs");
}

async function threadLog(
  fixture: ReturnType<typeof createFixture>,
  threadId: string,
  expected: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const filePath = path.join(logDirectory(fixture), "threads", `${threadId}.jsonl`);
  let lines: Record<string, unknown>[] = [];
  await vi.waitFor(() => {
    lines = readFileSync(filePath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
  });
  return lines;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture) await closeFixture(fixture).catch(() => undefined);
  }
});

describe("Host diagnostic logging", () => {
  it("writes one log per External Thread conversation", async () => {
    const fixture = host();
    const threadId = await startPiThread(fixture);
    const turnId = await completePiTurn(fixture, threadId, 2);
    const lines = await threadLog(fixture, threadId, { event: "turn.completed", turnId });

    expect(lines.every((line) => line.hostThreadId === threadId)).toBe(true);
    expect(lines.every((line) => line.harnessId === "pi")).toBe(true);
    const events = lines.map((line) => line.event);
    expect(events).toContain("session.opened");
    expect(events).toContain("thread.created");
    expect(events).toContain("turn.started");
    const completed = lines.find(
      (line) => line.event === "turn.completed" && line.turnId === turnId,
    );
    expect(completed).toMatchObject({ level: "info", status: "succeeded" });
  });

  it("keeps the Turn text and the Agent reply out of the log", async () => {
    const fixture = host();
    const threadId = await startPiThread(fixture);
    const prompt = "SENTINEL_PROMPT_TEXT";
    const reply = "SENTINEL_AGENT_REPLY";
    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: prompt }] },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 2));
    const turnId = ((response.result as Record<string, unknown>).turn as Record<string, unknown>)
      .id as string;
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.appendText(reply);
    session.succeedTurn();
    await fixture.collector.waitFor(
      (message) => message.method === "turn/completed" && messageTurnId(message) === turnId,
    );

    const lines = await threadLog(fixture, threadId, { event: "turn.completed", turnId });
    const contents = JSON.stringify(lines);
    expect(contents).not.toContain(prompt);
    expect(contents).not.toContain(reply);
    // The sizes are recorded in place of the text.
    expect(lines.find((line) => line.event === "item.completed")).toMatchObject({
      textChars: reply.length,
    });
  });

  it("records a failed Thread-scoped Desktop request against its Thread", async () => {
    const fixture = host();
    const threadId = await startPiThread(fixture);
    writeRequest(fixture.desktopInput, {
      id: 50,
      method: "thread/rollback",
      params: { threadId, numTurns: 99 },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 50));
    expect(response).toHaveProperty("error");

    const lines = await threadLog(fixture, threadId, {
      event: "desktop.request.failed",
      requestId: 50,
    });
    expect(lines.find((line) => line.event === "desktop.request.failed")).toMatchObject({
      level: "warn",
      method: "thread/rollback",
      requestId: 50,
    });
  });

  it("writes process-level events outside any Thread log", async () => {
    const fixture = host();
    await fixture.ready;
    let started: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      const directory = path.join(logDirectory(fixture), "runtime");
      const files = (listFiles(directory) ?? []).map((file) => path.join(directory, file));
      const lines = files.flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );
      started = lines.find((line) => line.event === "host.started");
      expect(started).toBeDefined();
    });
    expect(started).toMatchObject({ level: "info", platform: process.platform });
    expect(started).not.toHaveProperty("hostThreadId");
  });

  it("writes nothing when logging is disabled", async () => {
    const fixture = host({ CODEXHOST_LOG_LEVEL: "off" });
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);
    expect(listFiles(path.join(logDirectory(fixture), "threads"))).toBeUndefined();
  });
});

function listFiles(directory: string): string[] | undefined {
  try {
    return readdirSync(directory);
  } catch {
    return undefined;
  }
}
