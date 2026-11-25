import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { jsonObjectSchema, type JsonObject } from "@codexhost/shared-contracts";
import { object } from "../src/counters.js";
import { createUsageStatisticsAdapter } from "../src/plugin.js";
import type { HarnessSessionUsageObservation } from "@codexhost/harness-adapter/plugin";

// Explicit opt-in only. Runs a real app-server against a loopback Responses fixture;
// no real credentials, upstream model requests, shell tools or paid inference.
const binary = process.env.CODEXHOST_TEST_CODEX;
it.skipIf(!binary)(
  "native raw completion precedes tool waiting and measures multiple responses",
  async () => {
    if (!binary) return;
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-timing-native-"));
    let requests = 0;
    let toolAnsweredAt = 0;
    let slowNextResponse = false;
    let cancelOnDelta = false;
    const server = createServer(async (request, response) => {
      if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
        response.writeHead(404).end();
        return;
      }
      for await (const chunk of request) {
        void chunk; // Drain without logging request contents.
      }
      const index = ++requests;
      const responseId = `resp_fixture_${index}`;
      const item = {
        type: "message",
        id: `msg_${index}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: index === 1 ? "working" : "done", annotations: [] }],
      };
      const tool = {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "fixture_pause",
        arguments: "{}",
        status: "completed",
      };
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (event: object) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      send({ type: "response.created", response: { id: responseId, status: "in_progress" } });
      const reasoning = { type: "reasoning", id: `rs_${index}`, summary: [] };
      send({ type: "response.output_item.added", output_index: 0, item: reasoning });
      await delay(20);
      send({ type: "response.output_item.done", output_index: 0, item: reasoning });
      send({
        type: "response.output_item.added",
        output_index: 1,
        item: { ...item, status: "in_progress", content: [] },
      });
      send({
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 1,
        content_index: 0,
        delta: index === 1 ? "working" : "done",
      });
      const slow = slowNextResponse;
      slowNextResponse = false;
      await delay(slow ? 200 : 40);
      if (response.destroyed) return;
      send({ type: "response.output_item.done", output_index: 1, item });
      if (index === 1) {
        send({
          type: "response.output_item.added",
          output_index: 2,
          item: { ...tool, status: "in_progress", arguments: "" },
        });
        send({
          type: "response.function_call_arguments.delta",
          item_id: tool.id,
          output_index: 2,
          delta: "{}",
        });
        send({ type: "response.output_item.done", output_index: 2, item: tool });
      }
      send({
        type: "response.completed",
        response: {
          id: responseId,
          status: "completed",
          output: index === 1 ? [reasoning, item, tool] : [reasoning, item],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            input_tokens_details: { cached_tokens: 50 },
            output_tokens_details: { reasoning_tokens: 8 },
          },
        },
      });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const spawnNative = () =>
      spawn(
        binary,
        [
          "app-server",
          "--stdio",
          "-c",
          'model_provider="fixture"',
          "-c",
          'model="gpt-5.4"',
          "-c",
          'model_providers.fixture.name="Fixture"',
          "-c",
          `model_providers.fixture.base_url="http://127.0.0.1:${address.port}/v1"`,
          "-c",
          'model_providers.fixture.wire_api="responses"',
          "-c",
          "model_providers.fixture.requires_openai_auth=false",
        ],
        {
          cwd: home,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CODEX_HOME: home,
            NO_PROXY: "127.0.0.1,localhost",
            no_proxy: "127.0.0.1,localhost",
            HTTP_PROXY: "",
            HTTPS_PROXY: "",
            ALL_PROXY: "",
          },
          stdio: "pipe",
        },
      );
    let child = spawnNative();
    const plugin = createUsageStatisticsAdapter({
      environment: { CODEX_HOME: home },
      platform: process.platform,
      managedRemoteHost: false,
    });
    const events: Array<{ method: string; at: number }> = [];
    const timings: HarnessSessionUsageObservation[] = [];
    const replies = new Map<
      number,
      { resolve: (value: JsonObject) => void; reject: (error: Error) => void }
    >();
    let completed = Promise.withResolvers<undefined>();
    void completed.promise.catch(() => undefined);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    let lines = createInterface({ input: child.stdout });
    const send = (value: object) => {
      if (!child.killed) child.stdin.write(JSON.stringify(value) + "\n");
    };
    let id = 0;
    const rpc = (method: string, params: object) =>
      new Promise<JsonObject>((resolve, reject) => {
        const key = ++id;
        const timeout = setTimeout(() => {
          replies.delete(key);
          reject(new Error(`Timed out: ${method}; ${stderr}`));
        }, 10000);
        replies.set(key, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        send({ id: key, method, params });
      });
    const onLine = (line: string) => {
      const message = jsonObjectSchema.parse(JSON.parse(line));
      const now = Date.now();
      if (typeof message.method === "string") events.push({ method: message.method, at: now });
      if (message.method === "error") stderr += JSON.stringify(message.params);
      if (cancelOnDelta && message.method === "item/agentMessage/delta") {
        cancelOnDelta = false;
        const params = object(message.params);
        void rpc("turn/interrupt", { threadId: params?.threadId, turnId: params?.turnId }).catch(
          (error: Error) => completed.reject(error),
        );
      }
      const observation = plugin.sessionUsage?.observe(message, now);
      if (observation?.requestTiming || observation?.timingUnavailable) timings.push(observation);
      if (message.method === "item/tool/call") {
        // Hold a native tool for substantially longer than either model response.
        void delay(300).then(() => {
          toolAnsweredAt = Date.now();
          send({
            id: message.id,
            result: {
              contentItems: [{ type: "inputText", text: "fixture finished" }],
              success: true,
            },
          });
        });
      } else if (message.method === "turn/completed") {
        const turn = object(object(message.params)?.turn);
        if (turn?.status === "failed") completed.reject(new Error(JSON.stringify(turn.error)));
        else completed.resolve(undefined);
      } else if (typeof message.id === "number" && !message.method) {
        const pending = replies.get(message.id);
        replies.delete(message.id);
        if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
        else pending?.resolve(jsonObjectSchema.parse(message.result));
      }
    };
    lines.on("line", onLine);
    try {
      const initializeParams = {
        clientInfo: { name: "codexhost-usage-fixture", version: "1" },
        capabilities: {
          experimentalApi: true,
          // Desktop excludes these notifications and sets raw events false on new Threads.
          optOutNotificationMethods: ["rawResponse/completed", "turn/diff/updated"],
        },
      };
      const nativeInitialize = {
        ...initializeParams,
        ...plugin.sessionUsage?.requestOptions?.({
          method: "initialize",
          params: initializeParams,
          initializeParams: null,
        }),
      };
      await rpc("initialize", nativeInitialize);
      send({ method: "initialized", params: {} });
      const patch = plugin.sessionUsage?.requestOptions?.({
        method: "thread/start",
        params: { experimentalRawEvents: false },
        initializeParams: nativeInitialize,
      });
      const started = await rpc("thread/start", {
        cwd: home,
        model: "gpt-5.4",
        approvalPolicy: "never",
        sandbox: "read-only",
        experimentalRawEvents: false,
        dynamicTools: [
          {
            name: "fixture_pause",
            description: "A local test pause",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        ...patch,
      });
      const thread = object(started.thread);
      if (typeof thread?.id !== "string") throw new Error("Missing native thread ID");
      await rpc("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: "Run the fixture pause, then finish." }],
      });
      await Promise.race([
        completed.promise,
        delay(10000).then(() => {
          throw new Error(
            `Turn timed out; requests=${requests}; events=${events.map((event) => event.method).join(",")}; ${stderr}`,
          );
        }),
      ]);
      expect(requests).toBe(2);
      expect(toolAnsweredAt).toBeGreaterThan(0);
      const raw = events.filter((event) => event.method === "rawResponse/completed");
      expect(raw).toHaveLength(2);
      expect(raw[0]?.at).toBeLessThan(toolAnsweredAt);
      const token = events.find((event) => event.method === "thread/tokenUsage/updated");
      expect(token?.at).toBeGreaterThanOrEqual(toolAnsweredAt);
      expect(timings.filter((event) => event.requestTiming)).toHaveLength(2);
      expect(timings.some((event) => event.timingUnavailable)).toBe(false);
      for (const measured of timings) {
        const timing = measured.requestTiming;
        if (!timing) continue;
        expect(timing.outputTokens).toBe(20);
        expect(timing.completedAtMs - timing.startedAtMs).toBeGreaterThan(0);
      }

      // A cold resume does not expose a raw-event opt-in. Missing evidence must hide TPS,
      // never carry a timestamp across the process/connection boundary or fake turn speed.
      const nativeExit = once(child, "exit");
      lines.close();
      child.kill("SIGKILL");
      await nativeExit;
      plugin.sessionUsage?.reset?.();
      child = spawnNative();
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      lines = createInterface({ input: child.stdout });
      lines.on("line", onLine);
      await rpc("initialize", nativeInitialize);
      send({ method: "initialized", params: {} });
      await rpc("thread/resume", { threadId: thread.id });
      const rawBeforeResume = events.filter(
        (event) => event.method === "rawResponse/completed",
      ).length;
      const measuredBeforeResume = timings.filter((event) => event.requestTiming).length;
      completed = Promise.withResolvers<undefined>();
      void completed.promise.catch(() => undefined);
      await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Finish." }] });
      await Promise.race([
        completed.promise,
        delay(10000).then(() => {
          throw new Error(`Resume timed out; ${stderr}`);
        }),
      ]);
      expect(requests).toBe(3);
      expect(events.filter((event) => event.method === "rawResponse/completed")).toHaveLength(
        rawBeforeResume,
      );
      expect(timings.filter((event) => event.requestTiming)).toHaveLength(measuredBeforeResume);

      // A newly created opted-in thread after reconnect can measure again.
      const fresh = await rpc("thread/start", {
        cwd: home,
        model: "gpt-5.4",
        approvalPolicy: "never",
        sandbox: "read-only",
        ...patch,
      });
      const freshThread = object(fresh.thread);
      if (typeof freshThread?.id !== "string") throw new Error("Missing fresh thread ID");
      completed = Promise.withResolvers<undefined>();
      void completed.promise.catch(() => undefined);
      await rpc("turn/start", {
        threadId: freshThread.id,
        input: [{ type: "text", text: "Finish." }],
      });
      await Promise.race([
        completed.promise,
        delay(10000).then(() => {
          throw new Error(`Fresh turn timed out; ${stderr}`);
        }),
      ]);
      expect(requests).toBe(4);
      expect(timings.filter((event) => event.requestTiming)).toHaveLength(measuredBeforeResume + 1);

      // Interrupt while the provider is still streaming: no endpoint, therefore no TPS.
      slowNextResponse = true;
      cancelOnDelta = true;
      const measuredBeforeCancel = timings.filter((event) => event.requestTiming).length;
      completed = Promise.withResolvers<undefined>();
      void completed.promise.catch(() => undefined);
      await rpc("turn/start", {
        threadId: freshThread.id,
        input: [{ type: "text", text: "Start the cancellable fixture." }],
      });
      await Promise.race([
        completed.promise,
        delay(10000).then(() => {
          throw new Error(`Cancel timed out; ${stderr}`);
        }),
      ]);
      expect(cancelOnDelta).toBe(false);
      expect(timings.filter((event) => event.requestTiming)).toHaveLength(measuredBeforeCancel);
      expect(timings.at(-1)?.timingUnavailable).toBeDefined();
    } finally {
      for (const pending of replies.values()) pending.reject(new Error("Fixture closed"));
      replies.clear();
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await plugin.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
