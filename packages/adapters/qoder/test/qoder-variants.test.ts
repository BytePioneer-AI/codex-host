import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessOutputChannel, type HarnessOutput } from "@codexhost/harness-adapter";
import {
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import * as globalSdk from "@qoder-ai/qoder-agent-sdk";
import * as cnSdk from "@qodercn-ai/qodercn-agent-sdk";
import { QoderAdapter } from "../src/qoder-adapter.js";
import { resolveQoderExecutable } from "../src/qoder-command.js";
import type { QoderQuery, SDKMessage, SessionMessage } from "../src/qoder-sdk-types.js";

vi.mock("@qoder-ai/qoder-agent-sdk", async (original) => ({
  ...(await original<typeof globalSdk>()),
  query: vi.fn(),
  getSessionMessages: vi.fn(),
  getSessionInfo: vi.fn(),
  forkSession: vi.fn(),
}));
vi.mock("@qodercn-ai/qodercn-agent-sdk", async (original) => ({
  ...(await original<typeof cnSdk>()),
  query: vi.fn(),
  getSessionMessages: vi.fn(),
  getSessionInfo: vi.fn(),
  forkSession: vi.fn(),
}));

class Query implements QoderQuery {
  readonly messages = new HarnessOutputChannel<SDKMessage>();
  readonly interrupt = vi.fn(async () => undefined);
  readonly close = vi.fn(() => this.messages.end());
  readonly getAvailableModels = vi.fn(async () => []);
  [Symbol.asyncIterator]() {
    return this.messages.outputs[Symbol.asyncIterator]();
  }
  push(message: unknown) {
    this.messages.emit(message as SDKMessage);
  }
}

function history(): SessionMessage[] {
  return [1, 2].flatMap((i) =>
    [
      { type: "user" as const, uuid: `user-${i}`, message: { role: "user", content: "Hello" } },
      {
        type: "assistant" as const,
        uuid: `answer-${i}`,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
          stop_reason: "end_turn",
        },
      },
    ].map((message) => ({
      ...message,
      session_id: "source",
      parent_tool_use_id: null,
      parent_agent_id: null,
    })),
  );
}

const variants = [
  {
    variant: "global",
    id: "qoder",
    command: "qodercli",
    editorCommand: "qoder",
    npmPackage: "@qoder-ai/qodercli",
    token: "QODER_PERSONAL_ACCESS_TOKEN",
    override: "CODEXHOST_QODER_COMMAND",
    sdk: globalSdk,
    other: cnSdk,
    foreign: "qoder-cn",
  },
  {
    variant: "cn",
    id: "qoder-cn",
    command: "qoderclicn",
    editorCommand: "qodercn",
    npmPackage: "@qodercn-ai/qoderclicn",
    token: "QODERCN_PERSONAL_ACCESS_TOKEN",
    override: "CODEXHOST_QODERCN_COMMAND",
    sdk: cnSdk,
    other: globalSdk,
    foreign: "qoder",
  },
] as const;
const adapters: QoderAdapter[] = [];
beforeEach(() => vi.resetAllMocks());
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

for (const v of variants)
  describe(v.id, () => {
    function setup(environment: Record<string, string> = {}) {
      const query = new Query();
      // Only the native SDK calls are mocked; auth helpers retain each published package's defaults.
      vi.mocked(v.sdk.query).mockReturnValue(query as unknown as ReturnType<typeof v.sdk.query>);
      vi.mocked(v.sdk.getSessionMessages).mockResolvedValue(history());
      vi.mocked(v.sdk.getSessionInfo).mockResolvedValue(undefined);
      vi.mocked(v.sdk.forkSession).mockResolvedValue({ sessionId: "derived" });
      const resolveExecutable = vi.fn(() => v.command);
      const adapter = new QoderAdapter({ variant: v.variant, environment, resolveExecutable });
      adapters.push(adapter);
      return { adapter, query, resolveExecutable };
    }
    const ref = (id = v.id as string) =>
      nativeSessionRefSchema.parse({ harnessId: id, nativeSessionId: "source", formatVersion: 1 });
    const checkpoint = (id = v.id as string) =>
      nativeCheckpointRefSchema.parse({
        harnessId: id,
        nativeSessionId: "source",
        checkpointId: "answer-1",
        formatVersion: 1,
      });

    it("uses its own SDK and PAT for inspect and open, including per-session overrides", async () => {
      const { adapter, resolveExecutable } = setup({
        QODER_PERSONAL_ACCESS_TOKEN: "global-test-token",
        QODERCN_PERSONAL_ACCESS_TOKEN: "cn-test-token",
        CODEXHOST_QODER_COMMAND: "global-command",
        CODEXHOST_QODERCN_COMMAND: "cn-command",
      });
      expect((await adapter.inspect()).status).toBe("ready");
      expect(resolveExecutable).toHaveBeenCalledWith(
        expect.objectContaining({ command: v.variant === "cn" ? "cn-command" : "global-command" }),
      );
      expect(v.sdk.query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            auth: { type: "accessToken", accessToken: { envVar: v.token } },
          }),
        }),
      );
      vi.mocked(v.sdk.query).mockReturnValue(
        new Query() as unknown as ReturnType<typeof v.sdk.query>,
      );
      const opened = await adapter.open({
        kind: "create",
        cwd: "/workspace",
        environment: { [v.token]: "session-token" },
      });
      expect(opened.ok).toBe(true);
      expect(v.sdk.query).toHaveBeenLastCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            env: expect.objectContaining({ [v.token]: "session-token" }),
            auth: { type: "accessToken", accessToken: { envVar: v.token } },
          }),
        }),
      );
      expect(v.other.query).not.toHaveBeenCalled();
    });

    it("does not use the other distribution's token", async () => {
      const { adapter } = setup({
        [v.variant === "cn" ? "QODER_PERSONAL_ACCESS_TOKEN" : "QODERCN_PERSONAL_ACCESS_TOKEN"]:
          "other-token",
      });
      await adapter.inspect();
      expect(v.sdk.query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ auth: { type: "qodercli" } }),
        }),
      );
    });

    it("preserves its Harness identity in live state, Turn and checkpoint refs", async () => {
      const { adapter, query } = setup();
      const opened = await adapter.open({ kind: "create", cwd: "/workspace" });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      expect(adapter.harnessId).toBe(v.id);
      expect(session.harnessId).toBe(v.id);
      expect(session.initialState.nativeRef?.harnessId).toBe(v.id);
      const outputs: HarnessOutput[] = [];
      const drained = (async () => {
        for await (const output of session.outputs) outputs.push(output);
      })();
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn"),
        input: [{ type: "text", text: "Hello" }],
      });
      query.push({ type: "system", subtype: "init", session_id: "source" });
      query.push({
        type: "assistant",
        uuid: "answer-1",
        message: { content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" },
      });
      query.push({ type: "result", subtype: "success" });
      await vi.waitFor(() =>
        expect(outputs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: expect.objectContaining({
                type: "turn.completed",
                nativeTurnRef: expect.objectContaining({ harnessId: v.id }),
                outcome: expect.objectContaining({
                  checkpoint: expect.objectContaining({ harnessId: v.id }),
                }),
              }),
            }),
          ]),
        ),
      );
      expect(outputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              type: "session.state.changed",
              state: expect.objectContaining({
                nativeRef: expect.objectContaining({ harnessId: v.id }),
              }),
            }),
          }),
        ]),
      );
      await session.close();
      await drained;
    });

    it("uses the same SDK for resume, snapshots, fork and rollback", async () => {
      const { adapter } = setup();
      const resumed = await adapter.open({ kind: "resume", cwd: "/workspace", nativeRef: ref() });
      if (!resumed.ok) throw new Error(resumed.error.message);
      expect(v.sdk.query).toHaveBeenCalledWith(
        expect.objectContaining({ options: expect.objectContaining({ resume: "source" }) }),
      );
      const snapshot = await resumed.value.readSnapshot();
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      for (const turn of snapshot.value.turns) {
        expect(turn.nativeTurnRef.harnessId).toBe(v.id);
        expect(turn.checkpoint?.harnessId).toBe(v.id);
      }
      expect(snapshot.value.turns).toHaveLength(2);
      expect(v.sdk.getSessionMessages).toHaveBeenCalledWith("source", {
        dir: "/workspace",
        view: "historical",
      });
      for (const kind of ["fork", "rollbackLastTurn"] as const) {
        vi.mocked(v.sdk.query).mockReturnValue(
          new Query() as unknown as ReturnType<typeof v.sdk.query>,
        );
        const opened = await adapter.open({
          kind,
          cwd: "/workspace",
          sourceRef: ref(),
          checkpoint: checkpoint(),
        });
        if (!opened.ok) throw new Error(opened.error.message);
        expect(opened.value.initialState.nativeRef).toMatchObject({
          harnessId: v.id,
          nativeSessionId: "derived",
        });
        expect(v.sdk.forkSession).toHaveBeenLastCalledWith("source", {
          dir: "/workspace",
          upToMessageId: "answer-1",
        });
      }
      expect(v.sdk.getSessionInfo).toHaveBeenCalledWith("source", { dir: "/workspace" });
      for (const operation of [
        "query",
        "getSessionMessages",
        "getSessionInfo",
        "forkSession",
      ] as const)
        expect(v.other[operation]).not.toHaveBeenCalled();
    });

    it("rejects foreign resume, fork, checkpoint and rollback before SDK calls", async () => {
      const { adapter } = setup();
      const requests = [
        { kind: "resume" as const, cwd: "/workspace", nativeRef: ref(v.foreign) },
        {
          kind: "fork" as const,
          cwd: "/workspace",
          sourceRef: ref(v.foreign),
          checkpoint: checkpoint(v.foreign),
        },
        {
          kind: "fork" as const,
          cwd: "/workspace",
          sourceRef: ref(),
          checkpoint: checkpoint(v.foreign),
        },
        { kind: "rollbackLastTurn" as const, cwd: "/workspace", sourceRef: ref(v.foreign) },
      ];
      for (const request of requests)
        expect(await adapter.open(request)).toMatchObject({
          ok: false,
          error: { code: "invalidRequest" },
        });
      for (const operation of [
        "query",
        "getSessionMessages",
        "getSessionInfo",
        "forkSession",
      ] as const)
        expect(v.sdk[operation]).not.toHaveBeenCalled();
    });

    it("resolves its Windows npm shim to its own package", () => {
      const shim = `C:\\npm\\${v.command}.cmd`;
      const entry = `C:\\npm\\node_modules\\${v.npmPackage.replaceAll("/", "\\")}\\bundle\\${v.command}.js`;
      expect(
        resolveQoderExecutable(
          { variant: v.variant, command: shim, platform: "win32", environment: {} },
          { isExecutable: (candidate) => candidate === shim || candidate === entry },
        ),
      ).toBe(entry);
    });

    it("rejects editor-only installations without starting an SDK query (#329)", async () => {
      const queryFactory = vi.fn();
      const adapter = new QoderAdapter({
        variant: v.variant,
        environment: { PATH: "/bin" },
        platform: "linux",
        queryFactory,
        resolveExecutable: (input) =>
          resolveQoderExecutable(
            { ...input, variant: v.variant },
            { isExecutable: (candidate) => candidate === `/bin/${v.editorCommand}` },
          ),
      });
      adapters.push(adapter);
      expect(await adapter.inspect()).toMatchObject({
        status: "notInstalled",
        error: { code: "notInstalled" },
      });
      expect(queryFactory).not.toHaveBeenCalled();
    });

    it("finds its own CLI, not the other distribution", () => {
      expect(
        resolveQoderExecutable(
          { variant: v.variant, platform: "linux", environment: { PATH: "/bin" } },
          { isExecutable: (candidate) => candidate === `/bin/${v.command}` },
        ),
      ).toBe(`/bin/${v.command}`);
      expect(() =>
        resolveQoderExecutable(
          { variant: v.variant, platform: "linux", environment: { PATH: "/bin" } },
          {
            isExecutable: (candidate) =>
              candidate === `/bin/${v.variant === "cn" ? "qodercli" : "qoderclicn"}`,
          },
        ),
      ).toThrow("not installed");
      expect(() =>
        resolveQoderExecutable(
          {
            variant: v.variant,
            platform: "linux",
            environment: { PATH: "/bin", [v.override]: "/missing/cli" },
          },
          { isExecutable: (candidate) => candidate === `/bin/${v.command}` },
        ),
      ).toThrow("not installed");
    });
  });
