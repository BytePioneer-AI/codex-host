import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { HermesGatewayTransport } from "../src/gateway-transport.js";
import { HermesGatewayHistory } from "../src/gateway-history.js";
import { resolveGatewayModel } from "../src/gateway-configuration.js";
import { hermesPythonCommand } from "../src/hermes-runtime.js";
import { openGatewaySession } from "../src/gateway-open.js";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import type { HermesSession } from "../src/hermes-session.js";

const launcher = process.env.CODEXHOST_HERMES_NATIVE_TEST_LAUNCHER;
// Opt-in installed runtime test. A temporary profile under the native home root
// shares only installed dependencies; config/history are isolated and removed.
// No model request, user transcript, source update or paid endpoint is used.
describe.skipIf(!launcher)("Hermes managed runtime history and gateway", () => {
  it("uses native bootstrap for model parsing, history, Fork, delegation and resume", async () => {
    if (!launcher) throw new Error("Missing Hermes test launcher");
    const root =
      process.env.CODEXHOST_HERMES_NATIVE_TEST_HOME_ROOT ?? path.join(os.homedir(), ".hermes");
    const home = await mkdtemp(path.join(root, "codexhost-managed-runtime-test-"));
    const environment = {
      ...process.env,
      HERMES_HOME: home,
      HERMES_DISABLE_LAZY_INSTALLS: "1",
      HERMES_QUIET: "1",
      OPENAI_API_KEY: "local-test",
      CODEXHOST_CLI_PATH: "test-cli",
      CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1",
      CODEXHOST_RUNTIME_TOKEN: "test-only",
      CODEXHOST_THREAD_ID: "test-parent",
    };
    let transport: HermesGatewayTransport | undefined;
    let session: HermesSession | undefined;
    try {
      await writeFile(
        path.join(home, "config.yaml"),
        "model:\n  default: test-model\n  provider: custom\n  base_url: http://127.0.0.1:1/v1\n",
      );
      const runtime = await HermesGatewayTransport.probe(launcher, home, environment);
      expect(runtime).not.toBeNull();
      if (!runtime) throw new Error("Missing native gateway runtime");
      expect(typeof runtime).toBe("object");
      transport = new HermesGatewayTransport(runtime, home, environment);
      expect(await resolveGatewayModel(transport, "custom:test-model")).toEqual({
        provider: "custom",
        model: "test-model",
      });
      const source = new HermesGatewayHistory({
        python: runtime,
        cwd: home,
        environment,
        nativeSessionId: "test-source",
      });
      await source.ensureCreated({ cwd: home, model: "test-model", provider: "custom" });
      const command = await hermesPythonCommand(
        runtime,
        "from hermes_state import SessionDB\ndb=SessionDB()\ndb.append_message('test-source','user',content='first')\ndb.append_message('test-source','assistant',content='reply')\ndb.append_message('test-source','user',content='second')\ndb.append_message('test-source','assistant',content='second reply')\ndb.close()",
        environment,
      );
      await promisify(execFile)(command.command, command.arguments, {
        env: environment,
        cwd: home,
        timeout: 20_000,
      });
      const before = await source.readSnapshot();
      expect(before.turns).toHaveLength(2);
      const checkpoint = before.turns[0]?.checkpoint;
      expect(checkpoint).toBeDefined();
      if (!checkpoint) throw new Error("Missing exact Fork boundary");
      const fork = await source.derive({ checkpoint });
      expect(fork.locator).toMatchObject({ transport: "gateway" });
      const child = new HermesGatewayHistory({
        python: runtime,
        cwd: home,
        environment,
        nativeSessionId: fork.nativeSessionId,
      });
      const snapshot = await child.readSnapshot();
      expect(snapshot.turns).toHaveLength(1);
      expect(snapshot.turns[0]?.input).toEqual([{ type: "text", text: "first" }]);
      expect(await source.readSnapshot()).toEqual(before);
      await transport.prepareSession();
      await transport.start();
      const resumed = await transport.request("session.resume", {
        session_id: fork.nativeSessionId,
        eager_build: false,
        omit_messages: true,
      });
      expect(resumed.session_id).toBeTruthy();
      await transport.close();
      transport = new HermesGatewayTransport(runtime, home, environment);
      const imported = nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "test-source",
        formatVersion: 1,
      });
      session = await openGatewaySession(
        { kind: "resume", nativeRef: imported, cwd: home },
        transport,
        () => {},
      );
      expect(session.initialState.nativeRef?.locator).toMatchObject({
        transport: "gateway",
        cwd: home,
      });
      expect(imported.locator).toBeUndefined();
      expect(await session.readSnapshot()).toMatchObject({ ok: true, value: before });
      await session.close();
      expect(await source.readSnapshot()).toEqual(before);
    } finally {
      await session?.close();
      await transport?.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
