import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotClient, ResumeSessionConfig, SessionEvent } from "@github/copilot-sdk";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { CopilotHarnessSession } from "../src/session.js";
import { createCopilotClient } from "../src/client.js";
import { sessionRef } from "../src/refs.js";
import { CopilotAdapter } from "../src/adapter.js";
vi.mock("../src/client.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createCopilotClient: vi.fn(),
}));
const id = "4c47b75e-1f33-4e80-a592-032e42c24f4b";
const ref = sessionRef(id);
function fixture() {
  const events: SessionEvent[] = JSON.parse(
    readFileSync(new URL("./fixtures/basic.json", import.meta.url), "utf8"),
  );
  const native = {
    sessionId: id,
    transcriptRecovery: undefined as unknown,
    getEvents: vi.fn(async () => events.filter((event) => !event.ephemeral)),
    disconnect: vi.fn(async () => {}),
    rpc: {
      model: {
        getCurrent: vi.fn(async () => ({ modelId: "auto" })),
        list: vi.fn(async () => ({ list: [], providers: [{ kind: "copilot" }] })),
      },
      mode: { get: vi.fn(async () => "interactive") },
      permissions: { getMode: vi.fn(async () => ({ mode: "manual" })) },
      usage: { getMetrics: vi.fn(async () => ({})) },
      tasks: { list: vi.fn(async () => ({ tasks: [] })) },
    },
  };
  return {
    native,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => []),
    forceStop: vi.fn(async () => {}),
    ping: vi.fn(async () => ({})),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    resumeSession: vi.fn<(id: string, config: ResumeSessionConfig) => Promise<typeof native>>(
      async () => native,
    ),
    rpc: {
      sessions: {
        checkInUse: vi.fn(async () => ({ inUse: [] as string[] })),
        readPersistedEvents: vi.fn(async () => {
          throw new Error("Unexpected full pagination before resume");
        }),
      },
    },
  };
}
let client: ReturnType<typeof fixture>;
beforeEach(() => {
  client = fixture();
  vi.mocked(createCopilotClient)
    .mockReset()
    .mockReturnValue(client as unknown as CopilotClient);
});
const open = () =>
  new CopilotHarnessSession(
    {
      kind: "resume",
      nativeRef: ref,
      cwd: process.cwd(),
      environment: { RESUME_MARKER: "current" },
    },
    { BASE_MARKER: "base" },
  );

describe("Copilot strict resume (synthetic SDK responses)", () => {
  it("retains the public cwd validation before opening a native connection", async () => {
    const adapter = new CopilotAdapter({ CODEXHOST_COPILOT_COMMAND: process.execPath });
    try {
      for (const cwd of ["relative/path", process.execPath])
        expect(await adapter.open({ kind: "resume", nativeRef: ref, cwd })).toMatchObject({
          ok: false,
          error: { code: "invalidRequest" },
        });
      expect(createCopilotClient).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });
  it("resumes the same identity without discarded pagination and reads the full snapshot on demand", async () => {
    const session = open();
    const outputs: HarnessOutput[] = [];
    const read = (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    try {
      await session.initialize();
      expect(client.resumeSession).toHaveBeenCalledWith(
        id,
        expect.objectContaining({
          allowTranscriptRecovery: false,
          workingDirectory: process.cwd(),
          enableConfigDiscovery: true,
        }),
      );
      expect(createCopilotClient).toHaveBeenCalledWith(
        expect.objectContaining({ sessionEnvironment: { RESUME_MARKER: "current" } }),
      );
      expect(client.rpc.sessions.readPersistedEvents).not.toHaveBeenCalled();
      expect(client.native.getEvents).not.toHaveBeenCalled();
      const first = await session.readSnapshot(),
        second = await session.readSnapshot();
      expect(second).toEqual(first);
      expect(first).toMatchObject({
        ok: true,
        value: { state: { nativeRef: ref }, turns: [{}, {}] },
      });
      expect(client.native.getEvents).toHaveBeenCalledTimes(2);
      expect(client.createSession).not.toHaveBeenCalled();
    } finally {
      await session.close();
      await read;
    }
    expect(
      outputs.some(
        (o) =>
          o.kind === "event" &&
          (o.event.type === "turn.started" || o.event.type === "item.started"),
      ),
    ).toBe(false);
    expect(client.deleteSession).not.toHaveBeenCalled();
  });

  it.each(["Session not found", "Cannot parse corrupt session transcript"])(
    "rejects %s without creating an empty replacement or deleting the source",
    async (message) => {
      client.resumeSession.mockRejectedValueOnce(new Error(message));
      const session = open();
      try {
        await expect(session.initialize()).rejects.toThrow(message);
        expect(client.resumeSession).toHaveBeenCalledWith(
          id,
          expect.objectContaining({ allowTranscriptRecovery: false }),
        );
        expect(await session.readSnapshot()).toMatchObject({
          ok: false,
          error: { code: "invalidState" },
        });
        expect(client.rpc.sessions.readPersistedEvents).not.toHaveBeenCalled();
        expect(client.createSession).not.toHaveBeenCalled();
      } finally {
        await session.close();
      }
      expect(client.deleteSession).not.toHaveBeenCalled();
    },
  );

  it("retains the occupied-session guard before resume", async () => {
    client.rpc.sessions.checkInUse.mockResolvedValue({ inUse: [id] });
    const session = open();
    try {
      await expect(session.initialize()).rejects.toMatchObject({ code: "sessionBusy" });
      expect(client.resumeSession).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it("rejects a changed native identity", async () => {
    client.native.sessionId = "11111111-1111-4111-8111-111111111111";
    const session = open();
    try {
      await expect(session.initialize()).rejects.toThrow("identity");
      expect(client.createSession).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });
  it("rejects a runtime that proposes recovery despite strict resume", async () => {
    client.native.transcriptRecovery = {
      invalidLineNumbers: [1],
      plannedBackupPath: "fixture-backup",
      sessionStartMoved: false,
    };
    const session = open();
    try {
      await expect(session.initialize()).rejects.toMatchObject({ code: "protocolError" });
      expect(client.native.getEvents).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
    expect(client.deleteSession).not.toHaveBeenCalled();
  });
});
