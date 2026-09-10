import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import { OfficialRuntimeOwner } from "../src/codex-runtime/official-runtime-owner.js";
import { OfficialWorkGate } from "../src/codex-runtime/official-work-gate.js";
import {
  createOwnedStdioBackend,
  createOwnedLoopbackBackend,
} from "../src/codex-runtime/owned-official-backends.js";
import { createRemoteOfficialAppServerConnection } from "../src/remote-official-connection.js";
import { OfficialAccountRuntime } from "../src/account/official-account-runtime.js";
import { CodexCredentialFiles } from "../src/account/codex-credential-files.js";
import { readOfficialCliVersion } from "../src/codex-runtime/official-cli-version.js";
import { NativePrivateFiles } from "../src/native-private-files.js";
import { readNativeProcessIdentity } from "../src/native-process-identity.js";
import { OfficialProcessRecord } from "../src/codex-runtime/official-process-record.js";

const stock = process.env.CODEXHOST_TEST_STOCK_CODEX_PATH;
const launcher = process.env.CODEXHOST_TEST_NATIVE_LAUNCHER;
const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Opt-in, isolated and credential-free. No Model Turn or inference is submitted; the configured
// Model endpoint is a synthetic loopback error server. Endpoint counters are not a network audit.
// A fixed `exit 0` user-shell command verifies native command completion separately.
// This is native lifecycle evidence, not real OAuth / billing / Desktop validation.
describe.skipIf(!stock || !launcher || process.platform !== "win32")(
  "native configuration bootstrap",
  () => {
    it.each([
      { transport: "stdio", plugins: false },
      { transport: "loopback", plugins: false },
      { transport: "loopback", plugins: true },
    ] as const)(
      "keeps bootstrap idle and restores the selected Model ($transport, plugins=$plugins)",
      async ({ transport, plugins }) => {
        if (!stock || !launcher) throw new Error("Explicit native CLI and launcher are required");
        const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-bootstrap-test-"));
        const home = path.join(root, "home");
        const files = new NativePrivateFiles({ launcher });
        await files.ensureDirectory(home);
        const credentials = new CodexCredentialFiles({
          files,
          directory: path.join(home, "slots"),
          sharedCodexHome: home,
        });
        const lease = await credentials.initialize();
        const record = new OfficialProcessRecord({
          files,
          sharedCodexHome: home,
          identity: (pid) => readNativeProcessIdentity(launcher, pid),
          assertOwnership: () => credentials.assertOwnership(),
        });
        let requests = 0;
        const server = createServer((request, response) => {
          if (request.url?.includes("responses")) requests++;
          request.resume();
          response.writeHead(503, { "content-type": "application/json" });
          response.end('{"error":{"message":"synthetic endpoint, no inference"}}');
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing synthetic endpoint");
        const environment = {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) =>
              /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|TEMP|TMP|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(
                key,
              ),
            ),
          ),
          CODEX_HOME: home,
          HOME: home,
          USERPROFILE: home,
          NO_PROXY: "*",
          no_proxy: "*",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: path.join(home, "empty-gitconfig"),
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
        };
        await writeFile(
          path.join(home, "config.toml"),
          `model = "synthetic"\nmodel_provider = "bootstrap_probe"\n[features]\ngoals = true\nplugins = ${plugins}\n[model_providers.bootstrap_probe]\nname = "Synthetic bootstrap probe"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`,
        );
        const gate = new OfficialWorkGate();
        const live = new Set<Promise<unknown>>();
        let endpoint: string | undefined;
        const owner = new OfficialRuntimeOwner({
          gate,
          diagnosticOutput: new PassThrough().resume(),
          createBackend: () => {
            const launch = {
              stockCodexPath: stock,
              cwd: home,
              environment,
              arguments: ["app-server"],
            };
            const diagnosticOutput = new PassThrough();
            let diagnostic = "";
            diagnosticOutput.on("data", (chunk: Buffer) => {
              diagnostic += chunk.toString();
              endpoint = diagnostic.match(/listening on:\s+(ws:\/\/127\.0\.0\.1:\d+)\s*\n/)?.[1];
            });
            const backend = record.wrap((receipt) => {
              const supervised = { ...launch, supervision: { launcher, files, receipt } };
              return transport === "stdio"
                ? createOwnedStdioBackend(supervised)
                : createOwnedLoopbackBackend({
                    ...supervised,
                    arguments: [...launch.arguments, "--listen", "ws://127.0.0.1:0"],
                    diagnosticOutput,
                  });
            });
            live.add(backend.closed);
            void backend.closed.then(() => live.delete(backend.closed));
            return backend;
          },
        });
        // Real private storage and native process receipts; no account credentials are installed.
        const runtime = new OfficialAccountRuntime({
          owner,
          credentials,
          environment,
          nativeVersion: () => readOfficialCliVersion(stock, environment),
          reconcilePreviousWriter: async () => {
            expect(live.size).toBe(0);
            await record.reconcile();
          },
        });
        const client = owner.attach(async () => {});
        const peer = transport === "loopback" ? owner.attach(async () => {}) : undefined;
        const failures: unknown[] = [];
        try {
          await owner.start();
          const initial = await client.initialize({
            clientInfo: { name: "codexhost_bootstrap_probe", version: "1" },
            capabilities: { experimentalApi: true },
          });
          expect(object(initial.result) && initial.result.userAgent).toEqual(
            expect.stringContaining("0.153.4"),
          );
          if (peer) {
            if (!endpoint) throw new Error("Missing isolated listener endpoint");
            await expect(
              createRemoteOfficialAppServerConnection(endpoint).then(async (unexpected) => {
                unexpected.close();
                await unexpected.closed;
                return unexpected;
              }),
            ).rejects.toThrow(/401|403/);
            await expect(
              createRemoteOfficialAppServerConnection(endpoint, {
                capabilityToken: "synthetic-wrong-token",
              }),
            ).rejects.toThrow("Private official connection failed");
            await peer.initialize({
              clientInfo: { name: "codexhost_bootstrap_peer", version: "1" },
              capabilities: { experimentalApi: true },
            });
          }
          gate.initialized();
          const started = await client.request("thread/start", { experimentalRawEvents: false });
          if (
            !object(started.result) ||
            !object(started.result.thread) ||
            typeof started.result.thread.id !== "string"
          )
            throw new Error("Synthetic Thread creation failed");
          const threadId = started.result.thread.id;
          if (peer)
            expect((await peer.request("thread/loaded/list", {})).result).toMatchObject({
              data: [threadId],
            });
          expect(
            (
              await client.request("thread/name/set", {
                threadId,
                name: "Synthetic bootstrap fixture",
              })
            ).error,
          ).toBeUndefined();
          if (peer)
            expect((await peer.request("thread/resume", { threadId })).error).toBeUndefined();
          const shell = await client.request("thread/shellCommand", {
            threadId,
            command: "exit 0",
            timeoutMs: 1000,
          });
          expect(shell.error).toBeUndefined();
          await vi.waitFor(() => expect(gate.busy).toBe(false), { timeout: 5000 });
          const selected = await owner.controlRequest("thread/settings/update", {
            threadId,
            model: "synthetic-selected",
          });
          expect(selected.error).toBeUndefined();
          const capture = gate.beginChange();
          const currentThread = await owner.controlRequest("thread/read", {
            threadId,
            includeTurns: false,
          });
          if (!object(currentThread.result) || !object(currentThread.result.thread))
            throw new Error("Missing native Thread");
          owner.captureThreadSettings([currentThread.result.thread]);
          capture.finish("ready");
          const goal = await owner.controlRequest("thread/goal/set", {
            threadId,
            objective: "Synthetic offline lifecycle goal",
            status: "active",
            tokenBudget: 1,
          });
          expect(goal.error).toBeUndefined();
          const queued = await owner.controlRequest("thread/queue/add", {
            threadId,
            clientUserMessageId: randomUUID(),
            input: [{ type: "text", text: "Synthetic pending input", text_elements: [] }],
          });
          expect(queued.error).toBeUndefined();
          if (
            !object(queued.result) ||
            !object(queued.result.queuedSubmission) ||
            typeof queued.result.queuedSubmission.id !== "string"
          )
            throw new Error("Missing synthetic queued submission");
          const queuedSubmissionId = queued.result.queuedSubmission.id;
          const queue = await owner.controlRequest("thread/queue/list", {
            threadId,
            cursor: null,
            limit: 10,
          });
          expect(
            object(queue.result) && Array.isArray(queue.result.data) && queue.result.data.length,
          ).toBe(1);
          await owner.stop();
          const before = requests;
          await owner.start();
          const config = await owner.controlRequest("config/read", { includeLayers: true });
          expect(
            object(config.result) &&
              object(config.result.config) &&
              config.result.config.cli_auth_credentials_store,
          ).toBe("file");
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const loaded = await owner.controlRequest("thread/loaded/list", {});
          expect(loaded.result).toMatchObject({ data: [], nextCursor: null });
          expect(requests).toBe(before);
          expect(gate.busy).toBe(false);
          const persistedQueue = await owner.controlRequest("thread/queue/list", {
            threadId,
            cursor: null,
            limit: 10,
          });
          expect(persistedQueue.result).toMatchObject({
            data: [expect.anything()],
            nextCursor: null,
          });
          const persistedGoal = await owner.controlRequest("thread/goal/get", { threadId });
          expect(persistedGoal.result).toMatchObject({ goal: { status: "active" } });
          await expect(runtime.assertNativeIdle()).rejects.toMatchObject({ code: "busy" });
          await owner.stop();
          await runtime.preflight();
          expect(owner.running).toBe(false);
          expect(live.size).toBe(0);
          expect(await readdir(path.join(home, "slots"))).toEqual([]);
          await owner.start();
          expect(
            (await owner.controlRequest("thread/queue/list", { threadId, cursor: null, limit: 10 }))
              .result,
          ).toMatchObject({ data: [expect.anything()] });
          expect(
            (await owner.controlRequest("thread/queue/delete", { threadId, queuedSubmissionId }))
              .error,
          ).toBeUndefined();
          expect(
            (await owner.controlRequest("thread/goal/clear", { threadId })).error,
          ).toBeUndefined();
          await vi.waitFor(() => expect(gate.busy).toBe(false));
          gate.initialized();
          await client.request("turn/interrupt", { threadId, turnId: "synthetic-absent" });
          await peer?.request("turn/interrupt", { threadId, turnId: "synthetic-absent" });
          const restoredSettings = await owner.controlRequest("thread/read", {
            threadId,
            includeTurns: false,
          });
          expect(restoredSettings.result).toMatchObject({
            thread: { model: "synthetic-selected", modelProvider: "bootstrap_probe" },
          });
          expect(requests).toBe(before);
        } catch (error) {
          failures.push(error);
        } finally {
          await owner.stop().catch((error: unknown) => failures.push(error));
          client.close();
          peer?.close();
          await lease.release();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }).catch(
            (error: unknown) => failures.push(error),
          );
        }
        if (failures.length) throw new AggregateError(failures, "Isolated native probe failed");
      },
      30_000,
    );
  },
);
