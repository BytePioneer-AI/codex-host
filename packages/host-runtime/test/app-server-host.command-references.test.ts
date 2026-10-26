import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import type { HarnessCommandInvocation } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  encodeHarnessPluginRoute,
  harnessCommandDescriptorSchema,
  harnessIdSchema,
  hostItemIdSchema,
} from "@codexhost/shared-contracts";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { runDelegationCli } from "../src/delegation-cli.js";
import {
  createFixture,
  requestId,
  startExternalThread,
  startPiThread,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

const previousHost = "ssh:previous";
const currentHost = "remote-ssh-discovered:mac";
const command = harnessCommandDescriptorSchema.parse({
  id: "native.init",
  invocation: "/init",
  label: "Init",
  argumentMode: "none",
});

async function fixture(method: "turn/start" | "turn/steer") {
  const registry = new DelegationControlRegistry({
    remoteRead: async () => {
      throw new Error("Desktop forwarding unavailable");
    },
  });
  const claude = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
  const f = createFixture({
    onDelegationApi: (api) => registry.register(api),
    externalAdapters: new Map([
      ["pi", new FakeHarnessAdapter(harnessIdSchema.parse("pi"))],
      ["claude-code", claude],
    ]),
  });
  const server = await startDelegationControlServer({ token: "synthetic", api: registry });
  const close = async () => {
    await server.close();
    registry.close();
    await stopFixture(f);
  };
  try {
    const target = await startPiThread(f);
    const threadId = await startExternalThread(
      f,
      encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("claude-code") }),
      10,
    );
    const session = claude.sessions[0];
    if (!session) throw new Error("Missing native fixture Session");
    writeRequest(f.desktopInput, {
      id: 20,
      method: "turn/start",
      params: {
        threadId,
        codexhostSourceHostId: previousHost,
        input: [{ type: "text", text: "previous turn" }],
      },
    });
    const initial = await f.collector.waitFor((m) => requestId(m, 20));
    expect(initial).not.toHaveProperty("error");
    const previousTurn = String(((initial.result as JsonObject).turn as JsonObject).id);
    if (method === "turn/start") {
      session.succeedTurn();
      await f.collector.waitFor((m) => turnEvent(m, "turn/completed", previousTurn));
    } else session.completeCancellationOnRequest();

    const read = async (hostId: string) => {
      const output = new PassThrough();
      const diagnosticOutput = new PassThrough();
      const reference = `thread://${target}?hostId=${encodeURIComponent(hostId)}`;
      const code = await runDelegationCli({
        arguments: ["thread", "read", reference, "--format", "compact"],
        environment: {
          CODEXHOST_RUNTIME_ENDPOINT: server.endpoint,
          CODEXHOST_RUNTIME_TOKEN: "synthetic",
          CODEXHOST_THREAD_ID: threadId,
        },
        output,
        diagnosticOutput,
      });
      if (code === 0)
        expect(JSON.parse(String(output.read()))).toMatchObject({
          harnessId: "pi",
          thread: reference,
        });
      return code;
    };
    const submit = async (hostId?: string) => {
      writeRequest(f.desktopInput, {
        id: 100,
        method,
        params: {
          threadId,
          input: [{ type: "text", text: "/init" }],
          ...(method === "turn/steer" ? { expectedTurnId: previousTurn } : {}),
          ...(hostId === undefined ? {} : { codexhostSourceHostId: hostId }),
        },
      });
      return f.collector.waitFor((m) => requestId(m, 100));
    };
    return { f, session, read, submit, close };
  } catch (error) {
    await close();
    throw error;
  }
}

it.each([
  ["turn/start", true],
  ["turn/steer", true],
  ["turn/start", false],
  ["turn/steer", false],
] as const)(
  "%s command applies supplied=%s Host context before invoking the CLI",
  async (method, supplied) => {
    const f = await fixture(method);
    try {
      const during: number[] = [];
      const execute = vi.fn(async ({ turnId }: HarnessCommandInvocation) => {
        during.push(await f.read(currentHost), await f.read(previousHost));
        f.session.publishEphemeralCommand(turnId, {
          type: "contextCompaction",
          itemId: hostItemIdSchema.parse("init-item"),
        });
        return { ok: true as const, value: { turnId } };
      });
      f.session.commands = {
        list: async () => ({ ok: true, value: { commands: [command] } }),
        execute,
      };
      const response = await f.submit(supplied ? currentHost : undefined);
      expect(response).not.toHaveProperty("error");
      expect(execute).toHaveBeenCalledOnce();
      expect(during).toEqual([supplied ? 0 : 1, 1]);
      const result = response.result as JsonObject;
      const turnId = method === "turn/steer" ? result.turnId : (result.turn as JsonObject).id;
      await f.f.collector.waitFor((m) => turnEvent(m, "turn/completed", String(turnId)));
      expect(await f.read(previousHost)).toBe(1);
    } finally {
      await f.close();
    }
  },
);

it.each([
  ["turn/start", "reject"],
  ["turn/start", "throw"],
  ["turn/steer", "reject"],
  ["turn/steer", "throw"],
] as const)(
  "restores prior Host context when %s command execution fails with %s",
  async (method, failure) => {
    const f = await fixture(method);
    try {
      const during: number[] = [];
      f.session.commands = {
        list: async () => ({ ok: true, value: { commands: [command] } }),
        execute: async () => {
          during.push(await f.read(currentHost), await f.read(previousHost));
          if (failure === "throw") throw new Error("Synthetic command failure");
          return {
            ok: false,
            error: {
              code: "nativeFailure",
              message: "Synthetic command failure",
              retryable: false,
            },
          };
        },
      };
      expect(await f.submit(currentHost)).toMatchObject({ error: { code: -32073 } });
      expect(during).toEqual([0, 1]);
      expect(await f.read(previousHost)).toBe(0);
      expect(await f.read(currentHost)).toBe(1);
    } finally {
      await f.close();
    }
  },
);
