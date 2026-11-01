import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, type SpawnOptions } from "node:child_process";
import { promisify } from "node:util";
import type * as ChildProcess from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { HermesGatewayTransport } from "../src/gateway-transport.js";
import { openGatewaySession } from "../src/gateway-open.js";
import { HermesAdapter } from "../src/hermes-adapter.js";

const nativeMetadata = vi.hoisted(() => ({ release: "" }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn(command: string, args: readonly string[] = [], options: SpawnOptions = {}) {
      const patched = [...args];
      const script = patched.indexOf("-c") + 1;
      if (nativeMetadata.release && script > 0 && patched[script]) {
        // Change only version metadata in this child. Run the installed native
        // gateway/storage code unchanged, without editing the Hermes installation.
        const metadata = `import hermes_cli\nfrom tui_gateway import server\nhermes_cli.__version__ = ${JSON.stringify(nativeMetadata.release)}\nserver.DESKTOP_BACKEND_CONTRACT = 999\n`;
        // Preserve each entry point's import-time stream ownership: history
        // redirects native logs; the gateway binds its RPC writer to stdout.
        const redirect = "sys.stdout = sys.stderr";
        patched[script] = patched[script].includes(redirect)
          ? patched[script].replace(redirect, `${redirect}\n${metadata}`)
          : metadata + patched[script];
      }
      return actual.spawn(command, patched, options);
    },
  };
});

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const python = process.env.CODEXHOST_HERMES_NATIVE_TEST_PYTHON;

// Runs the installed, verified gateway and real clarify tool against a local
// deterministic OpenAI-compatible server. No external model or user state.
describe.skipIf(!python)("Hermes installed gateway roundtrip", () => {
  it("creates, forks and resumes with different release and contract metadata through the real gateway", async () => {
    if (!python) throw new Error("Missing native Hermes interpreter");
    const home = await mkdtemp(path.join(os.tmpdir(), "hermes-gateway-native-test-"));
    const requests: ObjectValue[] = [];
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: "test", object: "model" }] }));
        return;
      }
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        try {
          const input = object(JSON.parse(body));
          requests.push(input);
          const messages = Array.isArray(input.messages) ? input.messages.map(object) : [];
          const tools = Array.isArray(input.tools) ? input.tools.map(object) : [];
          const hasClarify = tools.some((tool) => object(tool.function).name === "clarify");
          const answered = messages.some((message) => message.role === "tool");
          const call = {
            id: "native-clarify-call",
            type: "function",
            function: {
              name: "clarify",
              arguments: JSON.stringify({
                question: "Choose native values",
                choices: ["A, B", "C"],
                multi_select: true,
              }),
            },
          };
          const toolCall = hasClarify && !answered;
          const message = toolCall
            ? { role: "assistant", content: null, tool_calls: [call] }
            : { role: "assistant", content: "native-clarify-complete" };
          const usage = { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 };
          if (input.stream === true) {
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            });
            const chunk = (delta: unknown, finish: string | null) =>
              response.write(
                `data: ${JSON.stringify({ id: "chatcmpl-native-test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
              );
            chunk(
              toolCall ? { role: "assistant", tool_calls: [{ index: 0, ...call }] } : message,
              null,
            );
            chunk({}, toolCall ? "tool_calls" : "stop");
            response.write(
              `data: ${JSON.stringify({ id: "chatcmpl-native-test", object: "chat.completion.chunk", created: 1, model: "test", choices: [], usage })}\n\n`,
            );
            response.end("data: [DONE]\n\n");
          } else {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                id: "chatcmpl-native-test",
                object: "chat.completion",
                created: 1,
                model: "test",
                choices: [{ index: 0, message, finish_reason: toolCall ? "tool_calls" : "stop" }],
                usage,
              }),
            );
          }
        } catch {
          failResponse(response);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local provider port");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await writeFile(
      path.join(home, "config.yaml"),
      `model:\n  default: test\n  provider: custom\n  base_url: ${baseUrl}\n  api_mode: chat_completions\nagent:\n  reasoning_effort: low\n  max_turns: 4\n`,
    );
    const environment = {
      ...process.env,
      HERMES_HOME: home,
      OPENAI_API_KEY: "local-test",
      OPENAI_BASE_URL: baseUrl,
      HERMES_TUI_TOOL_PROGRESS: "all",
      HERMES_QUIET: "1",
    };
    const transport = new HermesGatewayTransport(python, home, environment, 30_000);
    let session: HarnessSession | undefined;
    let resumedTransport: HermesGatewayTransport | undefined;
    let questionCount = 0;
    nativeMetadata.release = "99.0.0-compatibility-test";
    try {
      session = await openGatewaySession({ kind: "create", cwd: home }, transport, () => undefined);
      const active = session;
      const iterator = active.outputs[Symbol.asyncIterator]();
      const sequentialOutputs = { [Symbol.asyncIterator]: () => iterator };
      const completed = (async (): Promise<HarnessOutput[]> => {
        const outputs: HarnessOutput[] = [];
        for await (const output of sequentialOutputs) {
          outputs.push(output);
          if (output.kind === "interaction" && output.interaction.type === "question") {
            questionCount++;
            const q = output.interaction.questions[0];
            if (!q) throw new Error("Missing native clarify question");
            expect(q).toMatchObject({
              type: "choice",
              multiple: true,
              prompt: "Choose native values",
            });
            const accepted = await active.execute({
              type: "interaction.respond",
              interactionId: output.interaction.interactionId,
              response: { type: "question", answers: { [q.id]: ["A, B", "C"] } },
            });
            expect(accepted.ok).toBe(true);
          }
          if (output.kind === "event" && output.event.type === "turn.completed") return outputs;
        }
        throw new Error("Gateway closed before turn completion");
      })();
      const started = await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("native-gateway-turn"),
        input: [
          {
            type: "text",
            text: "Use clarify to ask me which native values to select, then reply.",
          },
        ],
      });
      expect(started.ok).toBe(true);
      const outputs = await completed;
      expect(questionCount).toBe(1);
      expect(
        outputs.find((o) => o.kind === "event" && o.event.type === "turn.completed"),
      ).toMatchObject({ event: { outcome: { status: "succeeded" } } });
      const snapshot = await session.readSnapshot();
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      expect(snapshot.value.turns).toHaveLength(1);
      expect(snapshot.value.turns[0]?.checkpoint).toBeDefined();
      const tool = snapshot.value.turns[0]?.items.find(
        (item) => item.item.type === "toolExecution",
      );
      expect(tool?.item).toMatchObject({ toolName: "clarify" });
      expect(JSON.stringify(tool)).toContain("A, B");
      expect(
        requests.some(
          (r) => Array.isArray(r.messages) && r.messages.some((m) => object(m).role === "tool"),
        ),
      ).toBe(true);
      const commands = session.commands;
      if (!commands) throw new Error("Missing Hermes commands");
      for (const name of ["help", "tools", "context", "version"]) {
        expect((await commands.list()).ok).toBe(true);
        const output = (async () => {
          for await (const value of sequentialOutputs)
            if (value.kind === "event" && value.event.type === "turn.completed") return value;
        })();
        expect(
          (
            await commands.execute({
              turnId: hostTurnIdSchema.parse(`command-${name}`),
              commandId: `hermes.${name}`,
            })
          ).ok,
        ).toBe(true);
        expect(await output).toMatchObject({ event: { outcome: { status: "succeeded" } } });
      }
      expect(
        (await session.execute({ type: "thinking.select", thinkingOptionId: "high" as never })).ok,
      ).toBe(true);
      expect(
        (
          await session.execute({
            type: "permissionMode.select",
            permissionModeId: "dont_ask" as never,
          })
        ).ok,
      ).toBe(true);
      const configured = await session.readSnapshot();
      if (!configured.ok) throw new Error(configured.error.message);
      const nativeRef = configured.value.state?.nativeRef;
      if (!nativeRef) throw new Error("Missing native Hermes Session reference");
      await session.close();
      session = undefined;
      const checkpoint = snapshot.value.turns[0]?.checkpoint;
      if (!checkpoint) throw new Error("Missing native checkpoint");
      const forkTransport = new HermesGatewayTransport(python, home, environment, 30_000);
      let fork: HarnessSession | undefined;
      try {
        fork = await openGatewaySession(
          { kind: "fork", sourceRef: nativeRef, checkpoint, cwd: home },
          forkTransport,
          () => {},
        );
        expect(fork.initialState).toMatchObject({
          effectiveThinkingOptionId: "high",
          effectivePermissionModeId: "dont_ask",
          effectiveModel: configured.value.state?.effectiveModel,
        });
        const forked = await fork.readSnapshot();
        expect(forked.ok && forked.value.turns.length).toBe(1);
      } finally {
        await fork?.close();
        await forkTransport.close();
      }
      resumedTransport = new HermesGatewayTransport(python, home, environment, 30_000);
      session = await openGatewaySession(
        { kind: "resume", cwd: home, nativeRef },
        resumedTransport,
        () => undefined,
      );
      const resumed = await session.readSnapshot();
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) throw new Error(resumed.error.message);
      expect(resumed.value.turns[0]?.nativeTurnRef).toEqual(snapshot.value.turns[0]?.nativeTurnRef);
      expect(resumed.value.turns[0]?.items).toEqual(snapshot.value.turns[0]?.items);
    } finally {
      nativeMetadata.release = "";
      await session?.close();
      await transport.close();
      await resumedTransport?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  }, 90_000);
});

function failResponse(response: ServerResponse): void {
  response.writeHead(500, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "Invalid local fixture request" } }));
}

describe.skipIf(!python)("Hermes native outgoing delegation discovery", () => {
  it("registers process-local guidance while preserving user skills and terminal environment", async () => {
    if (!python) throw new Error("Missing native Hermes interpreter");
    const home = await mkdtemp(path.join(os.tmpdir(), "hermes-delegation-native-test-"));
    const skills = path.join(home, "skills");
    await mkdir(path.join(skills, "existing-guide"), { recursive: true });
    await writeFile(
      path.join(skills, "existing-guide", "SKILL.md"),
      "---\nname: existing-guide\ndescription: Existing user guidance.\n---\nUser skill preload remains active.\n",
    );
    const temporarySkills = async () =>
      (await readdir(os.tmpdir()))
        .filter((name) => name.startsWith("codexhost-hermes-delegation-"))
        .sort();
    const before = await temporarySkills();
    const cli = path.join(home, "host-cli");
    const runtimeToken = "fake-runtime-token-do-not-log";
    await writeFile(
      cli,
      `#!/bin/sh\n[ "$1" = "--help" ] || exit 10\n[ "$CODEXHOST_THREAD_ID" = "native-parent" ] || exit 11\n[ "$CODEXHOST_RUNTIME_ENDPOINT" = "local-runtime" ] || exit 12\n[ "$CODEXHOST_RUNTIME_TOKEN" = "${runtimeToken}" ] || exit 13\n[ "$CODEXHOST_CLI_PATH" = "$0" ] || exit 14\nprintf '%s\\n' 'native-delegation-env-ok'\n`,
      { mode: 0o700 },
    );
    const modelBodies: ObjectValue[] = [];
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: "test", object: "model" }] }));
        return;
      }
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        try {
          const input = object(JSON.parse(body));
          modelBodies.push(input);
          const messages = Array.isArray(input.messages) ? input.messages.map(object) : [];
          const tools = Array.isArray(input.tools) ? input.tools.map(object) : [];
          const hasTerminal = tools.some((t) => object(t.function).name === "terminal");
          const toolCall = hasTerminal && messages.at(-1)?.role === "user";
          const call = {
            id: "native-delegation-call",
            type: "function",
            function: {
              name: "terminal",
              arguments: JSON.stringify({ command: '"$CODEXHOST_CLI_PATH" --help' }),
            },
          };
          const message = toolCall
            ? { role: "assistant", content: null, tool_calls: [call] }
            : { role: "assistant", content: "native-delegation-complete" };
          const finish = toolCall ? "tool_calls" : "stop";
          if (input.stream === true) {
            response.writeHead(200, { "content-type": "text/event-stream" });
            for (const [delta, finishReason] of [
              [
                toolCall ? { role: "assistant", tool_calls: [{ index: 0, ...call }] } : message,
                null,
              ],
              [{}, finish],
            ])
              response.write(
                `data: ${JSON.stringify({ id: "chatcmpl-env", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
              );
            response.end("data: [DONE]\n\n");
          } else {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                id: "chatcmpl-env",
                object: "chat.completion",
                created: 1,
                model: "test",
                choices: [{ index: 0, message, finish_reason: finish }],
              }),
            );
          }
        } catch {
          failResponse(response);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing provider port");
    const url = `http://127.0.0.1:${address.port}/v1`;
    await writeFile(
      path.join(home, "config.yaml"),
      `model:\n  default: test\n  provider: custom\n  base_url: ${url}\n  api_mode: chat_completions\nagent:\n  max_turns: 4\n`,
    );
    const environment = {
      ...process.env,
      HERMES_HOME: home,
      OPENAI_API_KEY: "local-test",
      OPENAI_BASE_URL: url,
      CODEXHOST_HERMES_GATEWAY_PYTHON: python,
      HERMES_TUI_SKILLS: "existing-guide",
      CODEXHOST_CLI_PATH: cli,
      CODEXHOST_THREAD_ID: "native-parent",
      CODEXHOST_RUNTIME_ENDPOINT: "local-runtime",
      CODEXHOST_RUNTIME_TOKEN: runtimeToken,
    };
    const adapter = new HermesAdapter({
      command: path.join(path.dirname(python), "hermes"),
      environment,
    });
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: home,
        executionPolicy: "unattended-full-access",
        environment: { CODEXHOST_THREAD_ID: "" },
      });
      if (!opened.ok) throw new Error(opened.error.message);
      let session = opened.value;
      for (const phase of ["without-delegation", "resume", "resume-again"]) {
        expect(
          (await readdir(skills, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name),
        ).toEqual(["existing-guide"]);
        if (phase === "resume") {
          // A second real Hermes process sharing the same home cannot resolve
          // this gateway's in-memory Skill registration.
          await promisify(execFile)(
            python,
            [
              "-I",
              "-c",
              `import json
from tools.skills_tool import skill_view
assert not json.loads(skill_view("codexhost-runtime:delegation"))["success"]
`,
            ],
            { cwd: home, env: environment, timeout: 20_000 },
          );
        }
        modelBodies.length = 0;
        const complete = (async () => {
          for await (const output of session.outputs) {
            if (output.kind === "interaction")
              throw new Error("Unattended native terminal unexpectedly requested interaction");
            if (output.kind === "event" && output.event.type === "turn.completed")
              return output.event;
          }
          throw new Error("Native delegation probe closed before completion");
        })();
        const accepted = await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse(`native-env-${phase}`),
          input: [
            {
              type: "text",
              text: "Run only the configured Host CLI --help through your terminal. Do not delegate or print environment values.",
            },
          ],
        });
        expect(accepted.ok).toBe(true);
        expect(await complete).toMatchObject({ outcome: { status: "succeeded" } });
        const systems = modelBodies.flatMap((body) =>
          Array.isArray(body.messages)
            ? body.messages.map(object).filter((m) => m.role === "system")
            : [],
        );
        if (phase !== "without-delegation")
          expect(JSON.stringify(systems)).toContain("CODEXHOST_CLI_PATH");
        if (phase === "without-delegation")
          expect(JSON.stringify(systems)).not.toContain("delegate start");
        else expect(JSON.stringify(systems)).toContain("delegate start");
        expect(JSON.stringify(systems)).toContain("User skill preload remains active.");
        expect(JSON.stringify(modelBodies)).not.toContain(runtimeToken);
        const snapshot = await session.readSnapshot();
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        if (phase !== "without-delegation")
          expect(JSON.stringify(snapshot.value.turns.at(-1))).toContain("native-delegation-env-ok");
        await session.close();
        expect(await temporarySkills()).toEqual(before);
        if (phase !== "resume-again") {
          const nativeRef = snapshot.value.state?.nativeRef;
          if (!nativeRef) throw new Error("Missing native Hermes Session reference");
          const resumed = await adapter.open({
            kind: "resume",
            cwd: home,
            nativeRef,
          });
          if (!resumed.ok) throw new Error(resumed.error.message);
          session = resumed.value;
        }
      }
      expect(
        (await readdir(skills, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name),
      ).toEqual(["existing-guide"]);
    } finally {
      await adapter.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  }, 90_000);
});

describe.skipIf(!python)("Hermes native discovery resource lifetime", () => {
  it("cleans its private Skill without touching the user's home when spawning fails", async () => {
    if (!python) throw new Error("Missing native Hermes interpreter");
    const home = await mkdtemp(path.join(os.tmpdir(), "hermes-startup-native-test-"));
    const environment = {
      ...process.env,
      HERMES_HOME: home,
      CODEXHOST_CLI_PATH: "test-cli",
      CODEXHOST_THREAD_ID: "test-parent",
      CODEXHOST_RUNTIME_ENDPOINT: "test-endpoint",
      CODEXHOST_RUNTIME_TOKEN: "test-token",
    };
    const temporarySkills = async () =>
      (await readdir(os.tmpdir()))
        .filter((name) => name.startsWith("codexhost-hermes-delegation-"))
        .sort();
    const before = await temporarySkills();
    const transport = new HermesGatewayTransport(python, home, environment, 1000);
    try {
      await transport.prepareSession();
      expect((await temporarySkills()).filter((name) => !before.includes(name))).toHaveLength(1);
      expect(await readdir(home)).toEqual([]);
      // The user's home stays untouched, including on spawn failure.
      Object.defineProperty(transport, "python", { value: path.join(home, "missing-python") });
      await expect(transport.start()).rejects.toThrow();
      await transport.close();
      expect(await temporarySkills()).toEqual(before);
      expect(await readdir(home)).toEqual([]);
    } finally {
      await transport.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);
});
