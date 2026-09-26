import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  encodeHarnessPluginRoute,
  harnessIdSchema,
  hostThreadIdSchema,
} from "@codexhost/shared-contracts";
import { writePersonalProviderFixture } from "../../../tests/fixtures/zcode-provider.js";
import {
  createFixture,
  method,
  requestId,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const runtime = process.env.CODEXHOST_TEST_ZCODE_RUNTIME;
describe.skipIf(!runtime)("ZCode installed plugin through Host routing", () => {
  it("creates and executes a persistent native Thread without entering the official path", async () => {
    if (!runtime) throw new Error("No native runtime");
    const root = await mkdtemp(path.join(tmpdir(), "codexhost-zcode-host-"));
    const plugins = path.join(root, "plugins");
    await mkdir(plugins);
    await cp(
      path.resolve("packages/host-runtime/dist/plugins/zcode"),
      path.join(plugins, "zcode"),
      { recursive: true },
    );
    await writeFile(
      path.join(plugins, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["zcode"] }),
    );
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      response.setHeader("Content-Type", "text/event-stream");
      const event = (type: string, value: object) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      event("message_start", {
        message: {
          id: "fixture",
          type: "message",
          role: "assistant",
          model: input.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      });
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "ZCODE_HOST_ROUTE_OK" },
      });
      event("content_block_stop", { index: 0 });
      event("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      });
      event("message_stop", {});
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    await writePersonalProviderFixture(root, `http://127.0.0.1:${address.port}`);
    const fixture = createFixture({
      pluginDirectory: plugins,
      externalAdapters: new Map(),
      environment: {
        PATH: process.env.PATH,
        CODEXHOST_ZCODE_RUNTIME_DIR: runtime,
        ZCODE_DATA_BASE_DIR: root,
        ZCODE_CREDENTIAL_SECRET: "fixture-only",
        ZCODE_SESSION_DB_PATH: path.join(root, "native.sqlite"),
      },
    });
    try {
      const model = encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("zcode") });
      const threadId = await startExternalThread(fixture, model, 710, { cwd: root });
      writeRequest(fixture.desktopInput, {
        id: 711,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "Reply with the fixture response." }] },
      });
      const started = await fixture.collector.waitFor((message) => requestId(message, 711));
      expect(started).toMatchObject({ result: { turn: { id: expect.any(String) } } });
      const startedTurnId = (started.result as { turn: { id: string } }).turn.id;
      const completed = await fixture.collector.waitFor((message) =>
        method(message, "turn/completed"),
      );
      expect(completed).toMatchObject({ params: { turn: { status: "completed" } } });
      // A history read may repair a missing mapping and hide an earlier live completion failure.
      const persisted = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
      expect(persisted?.turnMappings).toEqual([
        expect.objectContaining({
          hostTurnId: startedTurnId,
          nativeTurnRef: expect.objectContaining({ harnessId: "zcode" }),
        }),
      ]);
      writeRequest(fixture.desktopInput, {
        id: 712,
        method: "thread/read",
        params: { threadId, includeTurns: true },
      });
      const history = await fixture.collector.waitFor((message) => requestId(message, 712));
      expect(history).not.toHaveProperty("error");
      expect(JSON.stringify(history)).toContain("ZCODE_HOST_ROUTE_OK");
      const reread = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
      expect(reread?.turnMappings).toEqual(persisted?.turnMappings);
      expect(fixture.official.stdin.read()).toBeNull();
    } finally {
      await stopFixture(fixture);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
