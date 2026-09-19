import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  hostTurnIdSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { ZcodeAdapter } from "../src/adapter.js";
import { installDelegationSkills } from "@codexhost/host-runtime";
import { record } from "../src/protocol.js";
import { writePersonalProviderFixture } from "./fixtures/personal-provider-config.js";

const runtime = process.env.CODEXHOST_TEST_ZCODE_RUNTIME;
const processRegistry = process.env.CODEXHOST_TEST_ZCODE_PROFILE === "process";
describe.skipIf(!runtime)(
  "ZCode installed runtime with an isolated database and local Provider",
  () => {
    let root: string, adapter: ZcodeAdapter;
    const requests: unknown[] = [];
    const toolEnvironment = {
      CODEXHOST_CLI_PATH: "/fixture/codexhost",
      CODEXHOST_THREAD_ID: "fixture-thread",
      CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1",
      CODEXHOST_RUNTIME_TOKEN: "test-only-runtime-token",
    };
    let goalChecks = 0;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const input = record(JSON.parse(body));
      requests.push(input);
      const messages = Array.isArray(input.messages) ? input.messages.map(record) : [];
      const last = messages.at(-1),
        content = Array.isArray(last?.content) ? last.content.map(record) : [];
      const toolResult = content.some((part) => part.type === "tool_result");
      const inputText = JSON.stringify(last ?? {});
      let blocks: unknown[] = [
        { type: "text", text: toolResult ? "Tool completed." : "Native reply." },
      ];
      if (input.stream === true && !toolResult) {
        if (inputText.includes("fixture-bash"))
          blocks = [
            {
              type: "tool_use",
              id: "call_bash",
              name: "Bash",
              input: {
                command: `printf fixture-tool-ok > ${path.join(root, "shell.txt")}`,
                description: "Print a fixture marker",
              },
            },
          ];
        if (inputText.includes("fixture-question"))
          blocks = [
            {
              type: "tool_use",
              id: "call_question",
              name: "AskUserQuestion",
              input: {
                questions: [
                  {
                    question: "Pick a color",
                    header: "Color",
                    options: [
                      { label: "Blue", description: "Blue color" },
                      { label: "Green", description: "Green color" },
                    ],
                    multiSelect: false,
                  },
                ],
              },
            },
          ];
        if (inputText.includes("fixture-subagent"))
          blocks = [
            {
              type: "tool_use",
              id: "call_agent",
              name: "Agent",
              input: {
                description: "Read fixture",
                prompt: "Reply child hello",
                subagent_type: "general-purpose",
              },
            },
          ];
        if (inputText.includes("fixture-environment"))
          blocks = [
            {
              type: "tool_use",
              id: "call_env",
              name: "Bash",
              input: {
                command: `printf '%s\\n' "$CODEXHOST_CLI_PATH" "$CODEXHOST_THREAD_ID" "$CODEXHOST_RUNTIME_ENDPOINT" "$CODEXHOST_RUNTIME_TOKEN"`,
                description: "Read test environment markers",
              },
            },
          ];
        if (inputText.includes("fixture-write"))
          blocks = [
            {
              type: "tool_use",
              id: "call_write",
              name: "Write",
              input: {
                file_path: path.join(root, "native.txt"),
                content: "created by native tool\n",
              },
            },
          ];
        if (inputText.includes("fixture-slow")) {
          response.on("close", () => clearTimeout(timer));
          const timer = setTimeout(() => send(response, input, blocks), 15_000);
          return;
        }
      }
      send(response, input, blocks);
    });
    function send(response: ServerResponse, input: Record<string, unknown>, blocks: unknown[]) {
      const stop = blocks.some((block) => record(block).type === "tool_use")
        ? "tool_use"
        : "end_turn";
      if (input.stream !== true) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model: input.model,
            content: [
              {
                type: "text",
                text: JSON.stringify(input).includes("Verify whether the active session goal")
                  ? JSON.stringify({
                      passed: ++goalChecks > 1,
                      reason: "Fixture reply present",
                      nextAction: "Reply once more",
                    })
                  : "Fixture title",
              },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 9, output_tokens: 6 },
          }),
        );
        return;
      }
      response.setHeader("content-type", "text/event-stream");
      const emit = (type: string, value: unknown) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...record(value) })}\n\n`);
      emit("message_start", {
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: input.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 9, output_tokens: 0 },
        },
      });
      blocks.forEach((value, index) => {
        const block = record(value);
        emit("content_block_start", {
          index,
          content_block:
            block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" },
        });
        emit("content_block_delta", {
          index,
          delta:
            block.type === "tool_use"
              ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
              : { type: "text_delta", text: block.text },
        });
        emit("content_block_stop", { index });
      });
      emit("message_delta", {
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: 6 },
      });
      emit("message_stop", {});
      response.end();
    }
    beforeAll(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "codexhost-zcode-test-"));
      await installDelegationSkills({ homeDirectory: root });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
      const config = path.join(root, "providers.json");
      await writeFile(
        config,
        JSON.stringify({
          provider: {
            fixture: {
              kind: "anthropic",
              options: { baseURL: `http://127.0.0.1:${address.port}`, apiKey: "test-only" },
              models: {
                "fixture-model": { limit: { context: 200000, output: 8192 } },
                "fixture-reasoning": {
                  reasoning: {
                    enabled: true,
                    levels: ["low", "high"],
                    defaultLevel: "high",
                    providerOptionsByLevel: {
                      low: { thinking: { type: "enabled", budgetTokens: 1024 } },
                      high: { thinking: { type: "enabled", budgetTokens: 4096 } },
                    },
                  },
                  limit: { context: 200000, output: 8192 },
                },
              },
            },
          },
        }),
      );
      if (processRegistry)
        await writePersonalProviderFixture(root, `http://127.0.0.1:${address.port}`);
      adapter = new ZcodeAdapter({
        command: required(runtime),
        timeoutMs: 10_000,
        environment: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) =>
                !key.toUpperCase().startsWith("ZCODE_") &&
                key.toUpperCase() !== "CODEXHOST_ZCODE_CONFIG",
            ),
          ),
          CODEXHOST_DATA_DIR: root,
          HOME: root,
          USERPROFILE: root,
          XDG_CONFIG_HOME: path.join(root, "config"),
          CODEXHOST_ZCODE_CONFIG: processRegistry ? undefined : config,
          ZCODE_DATA_BASE_DIR: root,
          ZCODE_SESSION_DB_PATH: path.join(root, "native.sqlite"),
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          http_proxy: "",
          https_proxy: "",
          all_proxy: "",
          NO_PROXY: "*",
          ZCODE_HTTP_PROXY: "",
          ZCODE_NO_PROXY: "*",
        },
      });
    });
    afterAll(async () => {
      await adapter?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (root) await rm(root, { recursive: true, force: true });
    });
    async function create() {
      const result = await adapter.open({
        kind: "create",
        cwd: root,
        environment: toolEnvironment,
        permissionModeId: harnessPermissionModeIdSchema.parse("build"),
      });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value;
    }
    function observe(session: HarnessSession) {
      const outputs: HarnessOutput[] = [];
      const done = (async () => {
        for await (const output of session.outputs) outputs.push(output);
      })();
      return { outputs, done };
    }
    async function waitFor(
      outputs: HarnessOutput[],
      predicate: (output: HarnessOutput) => boolean,
    ) {
      await expect
        .poll(() => outputs.find(predicate), { timeout: 20_000, interval: 25 })
        .toBeDefined();
      return required(outputs.find(predicate));
    }
    async function turn(
      session: HarnessSession,
      outputs: HarnessOutput[],
      id: string,
      prompt = "Reply briefly",
    ) {
      const turnId = hostTurnIdSchema.parse(id);
      expect(
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: prompt }],
        }),
      ).toEqual({ ok: true, value: { turnId } });
      return waitFor(
        outputs,
        (output) =>
          output.kind === "event" &&
          output.event.type === "turn.completed" &&
          output.event.turnId === turnId,
      );
    }

    it("inspects without persisted sessions, streams, persists, resumes, forks without rewinding files and rolls back", async () => {
      const before = await adapter.sessionImport.listCandidates();
      const inspection = await adapter.inspect({ cwd: root });
      expect(inspection.status).toBe("ready");
      expect(await adapter.sessionImport.listCandidates()).toEqual(before);
      const session = await create(),
        observed = observe(session);
      const completed = await turn(session, observed.outputs, "native-first");
      expect(completed).toMatchObject({
        kind: "event",
        event: { outcome: { status: "succeeded" } },
      });
      await turn(session, observed.outputs, "native-second");
      const snapshot = await session.readSnapshot();
      if (!snapshot.ok) throw new Error(JSON.stringify(snapshot));
      expect(snapshot.value.turns).toHaveLength(2);
      expect(
        snapshot.value.turns[0]?.items.filter(({ item }) => item.type === "agentMessage"),
      ).toHaveLength(1);
      const ref = required(session.initialState.nativeRef);
      await session.close();
      await observed.done;
      const alias = path.join(root, "workspace-alias");
      await symlink(root, alias, "junction");
      const resumed = await adapter.open({ kind: "resume", nativeRef: ref, cwd: alias + path.sep });
      if (!resumed.ok) throw new Error(JSON.stringify(resumed.error));
      expect(await resumed.value.readSnapshot()).toMatchObject({
        ok: true,
        value: { turns: snapshot.value.turns },
      });
      const continued = observe(resumed.value);
      await turn(resumed.value, continued.outputs, "native-third");
      await writeFile(path.join(root, "sentinel.txt"), "current workspace must stay\n");
      const forked = await adapter.open({
        kind: "fork",
        sourceRef: ref,
        checkpoint: required(required(snapshot.value.turns[0]).checkpoint),
        cwd: root,
      });
      if (!forked.ok) throw new Error(JSON.stringify(forked.error));
      expect(forked.value.initialState.nativeRef?.nativeSessionId).not.toBe(ref.nativeSessionId);
      const forkHistory = await forked.value.readSnapshot();
      expect(forkHistory.ok && forkHistory.value.turns.length).toBe(1);
      expect(forkHistory.ok && forkHistory.value.turns[0]?.outcome.status).toBe("succeeded");
      expect(await readFile(path.join(root, "sentinel.txt"), "utf8")).toBe(
        "current workspace must stay\n",
      );
      const forkOutput = observe(forked.value);
      await turn(forked.value, forkOutput.outputs, "fork-followup");
      await forked.value.close();
      await forkOutput.done;
      const rollback = await adapter.open({ kind: "rollbackLastTurn", sourceRef: ref, cwd: root });
      if (!rollback.ok) throw new Error(JSON.stringify(rollback.error));
      const rolled = await rollback.value.readSnapshot();
      expect(rolled.ok && rolled.value.turns.length).toBe(2);
      await rollback.value.close();
      await resumed.value.close();
      await continued.done;
    }, 90_000);
    it("maps tool approval, questions, files, cancellation and a following turn", async () => {
      const session = await create(),
        observed = observe(session);
      const work = turn(session, observed.outputs, "bash", "fixture-bash");
      const approval = await waitFor(observed.outputs, (output) => output.kind === "interaction");
      if (approval.kind !== "interaction" || approval.interaction.type !== "approval")
        throw new Error("No approval");
      expect(
        await session.execute({
          type: "interaction.respond",
          interactionId: approval.interaction.interactionId,
          response: { type: "approval", actionId: "invalid" },
        }),
      ).toMatchObject({ ok: false });
      const action = required(
        approval.interaction.actions.find((action) => action.effect === "allowOnce"),
      );
      expect(
        await session.execute({
          type: "interaction.respond",
          interactionId: approval.interaction.interactionId,
          response: { type: "approval", actionId: action.id },
        }),
      ).toMatchObject({ ok: true });
      expect(await work).toMatchObject({
        kind: "event",
        event: { outcome: { status: "succeeded" } },
      });
      expect(
        observed.outputs.some(
          (output) =>
            output.kind === "event" &&
            output.event.type === "item.completed" &&
            output.event.snapshot.item.type === "commandExecution",
        ),
      ).toBe(true);
      const questionWork = turn(session, observed.outputs, "question", "fixture-question");
      const question = await waitFor(
        observed.outputs,
        (output) => output.kind === "interaction" && output.interaction.type === "question",
      );
      if (question.kind !== "interaction") throw new Error("No question");
      expect(
        await session.execute({
          type: "interaction.respond",
          interactionId: question.interaction.interactionId,
          response: { type: "question", answers: { "0": ["Blue"] } },
        }),
      ).toMatchObject({ ok: true });
      expect(await questionWork).toMatchObject({
        kind: "event",
        event: { outcome: { status: "succeeded" } },
      });
      expect(
        await session.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("edit"),
        }),
      ).toMatchObject({ ok: true });
      await turn(session, observed.outputs, "write", "fixture-write");
      expect(
        observed.outputs.some(
          (output) =>
            output.kind === "event" &&
            output.event.type === "item.completed" &&
            output.event.snapshot.item.type === "fileChange",
        ),
      ).toBe(true);
      expect(await readFile(path.join(root, "native.txt"), "utf8")).toContain(
        "created by native tool",
      );
      const slow = turn(session, observed.outputs, "slow", "fixture-slow");
      await waitFor(
        observed.outputs,
        (output) =>
          output.kind === "event" &&
          output.event.type === "turn.started" &&
          output.event.turnId === "slow",
      );
      expect(
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("busy"),
          input: [{ type: "text", text: "Second" }],
        }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
      expect(
        await session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("slow") }),
      ).toMatchObject({ ok: true });
      expect(await slow).toMatchObject({
        kind: "event",
        event: { outcome: { status: "cancelled" } },
      });
      await turn(session, observed.outputs, "after-cancel");
      expect(
        await session.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("yolo"),
        }),
      ).toMatchObject({ ok: true });
      await turn(session, observed.outputs, "env", "fixture-environment");
      const envOutput = observed.outputs.find(
        (output) =>
          output.kind === "event" &&
          output.event.type === "item.completed" &&
          output.event.snapshot.item.itemId === "call_env",
      );
      if (
        envOutput?.kind !== "event" ||
        envOutput.event.type !== "item.completed" ||
        envOutput.event.snapshot.item.type !== "commandExecution"
      )
        throw new Error("No environment tool output");
      for (const value of Object.values(toolEnvironment))
        expect(envOutput.event.snapshot.item.output).toContain(value);
      expect(JSON.stringify(requests)).toContain("codexhost-delegation");
      await session.close();
      await observed.done;
    }, 90_000);
    it("runs native compact, goal controls, and child agents", async () => {
      const session = await create(),
        observed = observe(session);
      await turn(session, observed.outputs, "before-compact");
      expect(
        await required(session.commands).execute({
          commandId: "compact",
          turnId: hostTurnIdSchema.parse("compact"),
        }),
      ).toMatchObject({ ok: true });
      expect(
        await waitFor(
          observed.outputs,
          (o) =>
            o.kind === "event" && o.event.type === "turn.completed" && o.event.turnId === "compact",
        ),
      ).toMatchObject({ event: { outcome: { status: "succeeded" } } });
      await turn(session, observed.outputs, "after-compact");
      for (const argument of ["show", "pause", "clear"]) {
        const turnId = hostTurnIdSchema.parse(`goal-${argument}`);
        expect(
          await required(session.commands).execute({
            commandId: "goal",
            turnId,
            arguments: { text: argument },
          }),
        ).toMatchObject({ ok: true });
        expect(
          await waitFor(
            observed.outputs,
            (o) =>
              o.kind === "event" && o.event.type === "turn.completed" && o.event.turnId === turnId,
          ),
        ).toMatchObject({ event: { outcome: { status: "succeeded" } } });
      }
      expect(await turn(session, observed.outputs, "agent", "fixture-subagent")).toMatchObject({
        event: { outcome: { status: "succeeded" } },
      });
      const delegation = observed.outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "subagentDelegation",
      );
      if (
        !delegation ||
        delegation.kind !== "event" ||
        delegation.event.type !== "item.completed" ||
        delegation.event.snapshot.item.type !== "subagentDelegation"
      )
        throw new Error("No child agent");
      const child = required(delegation.event.snapshot.item.subagents[0]);
      const transcript = await adapter.subagents.readSnapshot({
        parent: required(session.initialState.nativeRef),
        nativeSubagentId: required(child.nativeSubagentId),
        cwd: root,
      });
      expect(transcript).toMatchObject({ ok: true });
      expect(transcript.ok && transcript.value.turns.length).toBeGreaterThan(0);
      const turnId = hostTurnIdSchema.parse("native-goal");
      expect(
        await required(session.commands).execute({
          commandId: "goal",
          turnId,
          arguments: { text: "Reply hello" },
        }),
      ).toMatchObject({ ok: true });
      expect(
        await waitFor(
          observed.outputs,
          (o) =>
            o.kind === "event" && o.event.type === "turn.completed" && o.event.turnId === turnId,
        ),
      ).toMatchObject({ event: { outcome: { status: "succeeded" } } });
      const autonomous = await waitFor(
        observed.outputs,
        (o) => o.kind === "event" && o.event.type === "turn.autonomous.started",
      );
      if (autonomous.kind !== "event" || autonomous.event.type !== "turn.autonomous.started")
        throw new Error("No autonomous turn");
      const autonomousId = autonomous.event.turnId;
      expect(
        await waitFor(
          observed.outputs,
          (o) =>
            o.kind === "event" &&
            o.event.type === "turn.completed" &&
            o.event.turnId === autonomousId,
        ),
      ).toMatchObject({ event: { outcome: { status: "succeeded" } } });
      await expect
        .poll(async () => (await session.readSnapshot()).ok, { timeout: 15000 })
        .toBe(true);
      const goalHistory = await session.readSnapshot();
      expect(
        goalHistory.ok && goalHistory.value.turns.slice(-2).map((turn) => turn.outcome.status),
      ).toEqual(["succeeded", "succeeded"]);
      await session.close();
      await observed.done;
    }, 90_000);
    it("confirms model/thinking changes and preserves them through one-turn rollback", async () => {
      const inspection = await adapter.inspect({ cwd: root });
      if (inspection.status !== "ready") throw new Error(JSON.stringify(inspection));
      const model = required(
        inspection.catalog.models.find((model) =>
          model.supportedThinkingOptionIds?.includes(harnessThinkingOptionIdSchema.parse("low")),
        ),
      );
      const session = await create(),
        observed = observe(session);
      expect(await session.execute({ type: "model.select", model: model.ref })).toMatchObject({
        ok: true,
      });
      expect(
        await session.execute({
          type: "thinking.select",
          thinkingOptionId: harnessThinkingOptionIdSchema.parse("low"),
        }),
      ).toMatchObject({ ok: true });
      await turn(session, observed.outputs, "configured");
      const snapshot = await session.readSnapshot();
      if (!snapshot.ok) throw new Error(JSON.stringify(snapshot));
      const rolled = await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: required(session.initialState.nativeRef),
        cwd: root,
        model: model.ref,
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("low"),
      });
      if (!rolled.ok) throw new Error(JSON.stringify(rolled));
      expect(snapshot.value.state?.effectiveThinkingOptionId).toBe("low");
      expect(rolled.value.initialState.effectiveModel).toEqual(model.ref);
      expect(rolled.value.initialState.effectiveThinkingOptionId).toBe("low");
      expect(await rolled.value.readSnapshot()).toMatchObject({ ok: true, value: { turns: [] } });
      await rolled.value.close();
      const other = required(
        inspection.catalog.models.find((entry) => entry.ref.id !== model.ref.id),
      );
      expect(await session.execute({ type: "model.select", model: other.ref })).toMatchObject({
        ok: true,
      });
      const changed = await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: required(session.initialState.nativeRef),
        cwd: root,
        model: model.ref,
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("low"),
      });
      if (!changed.ok) throw new Error(JSON.stringify(changed));
      expect(changed.value.initialState.effectiveModel).toEqual(model.ref);
      expect(changed.value.initialState.effectiveThinkingOptionId).toBe("low");
      await changed.value.close();
      await session.close();
      await observed.done;
    }, 40_000);
  },
);

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing native fixture value");
  return value;
}
