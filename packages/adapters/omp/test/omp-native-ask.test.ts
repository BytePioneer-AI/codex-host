import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { OmpAdapter } from "../src/omp-adapter.js";
import { encodeOmpModelRef } from "../src/omp-model-catalog.js";

const native = process.env.CODEXHOST_OMP_NATIVE_TEST_COMMAND;
type Request = {
  tools?: { function: { name: string } }[];
  messages?: { role: string; content?: unknown }[];
};

// Real OMP, native ask, and the public Adapter; only the model server is synthetic.
describe.skipIf(!native || process.platform === "win32")("OMP native ask", () => {
  it("advertises ask to the model and returns a Host answer to the native tool", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "omp-native-ask-"));
    const requests: Request[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const input: Request = JSON.parse(body);
        requests.push(input);
        const hasAsk = input.tools?.some((tool) => tool.function.name === "ask");
        const answered = input.messages?.some((message) => message.role === "tool");
        const invoke = hasAsk && !answered;
        const delta = invoke
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "native-ask-call",
                  type: "function",
                  function: {
                    name: "ask",
                    arguments: JSON.stringify({
                      questions: [
                        {
                          id: "language",
                          question: "Choose a language",
                          options: [
                            { label: "TypeScript", description: "Typed JavaScript" },
                            { label: "Python", description: "Python scripts" },
                          ],
                        },
                      ],
                    }),
                  },
                },
              ],
            }
          : { role: "assistant", content: answered ? "ASK_ANSWERED" : "ASK_MISSING" };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [chunk, reason] of [
          [delta, null],
          [{}, invoke ? "tool_calls" : "stop"],
        ]) {
          response.write(
            `data: ${JSON.stringify({ id: "chatcmpl-ask", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: chunk, finish_reason: reason }] })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local model port");
    const extension = path.join(directory, "provider.ts");
    await writeFile(
      extension,
      `export default function(pi) {
      pi.registerProvider("codexhost-ask-test", {
        baseUrl: "http://127.0.0.1:${address.port}/v1", apiKey: "local-test", api: "openai-completions",
        models: [{ id: "test", name: "Test", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
      });
    }`,
    );
    const command = path.join(directory, "omp-test");
    await writeFile(
      command,
      '#!/bin/sh\nexec "$CODEXHOST_OMP_NATIVE_TEST_COMMAND" "$@" --no-extensions --extension "$CODEXHOST_OMP_TEST_EXTENSION"\n',
      { mode: 0o700 },
    );
    const agentDirectory = path.join(directory, "agent");
    await mkdir(agentDirectory);
    const adapter = new OmpAdapter({
      command,
      environment: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDirectory,
        CODEXHOST_OMP_NATIVE_TEST_COMMAND: native,
        CODEXHOST_OMP_TEST_EXTENSION: extension,
      },
    });
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: directory,
        model: encodeOmpModelRef({ provider: "codexhost-ask-test", id: "test" }),
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      let questions = 0;
      const completed = (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "interaction" && output.interaction.type === "question") {
            questions++;
            const question = output.interaction.questions[0];
            if (!question || question.type !== "choice") throw new Error("Missing choice question");
            const selected = question.options.find((option) => option.label.includes("TypeScript"));
            expect(selected?.description).toBe("Typed JavaScript");
            if (!selected) throw new Error("Missing native option");
            const result = await session.execute({
              type: "interaction.respond",
              interactionId: output.interaction.interactionId,
              response: { type: "question", answers: { [question.id]: [selected.value] } },
            });
            expect(result.ok).toBe(true);
          }
          if (output.kind === "event" && output.event.type === "turn.completed")
            return output.event;
        }
        throw new Error("OMP closed before completion");
      })();
      expect(
        (
          await session.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse("native-ask-turn"),
            input: [{ type: "text", text: "Ask me to choose a language using ask." }],
          })
        ).ok,
      ).toBe(true);
      expect(await completed).toMatchObject({ outcome: { status: "succeeded" } });
      expect(requests[0]?.tools?.some((tool) => tool.function.name === "ask")).toBe(true);
      expect(questions).toBe(1);
      expect(
        JSON.stringify(
          requests.flatMap(
            (request) => request.messages?.filter((message) => message.role === "tool") ?? [],
          ),
        ),
      ).toContain("TypeScript");
    } finally {
      await adapter.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
