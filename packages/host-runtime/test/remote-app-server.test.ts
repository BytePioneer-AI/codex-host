import { once } from "node:events";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  createRemoteAppServerWebSocketListener,
  isRemoteUnixListenerInvocation,
  remoteAppServerSocketPath,
  stdioArgumentsForRemoteListener,
} from "../src/remote-app-server.js";

function testSocketPath(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\codexhost-remote-${process.pid}-${Date.now()}`
    : path.join("/tmp", `ch-${process.pid}-${Date.now()}`, "control.sock");
}

describe("remote SSH app-server transport", () => {
  it("classifies only Unix listener app-server invocations", () => {
    expect(
      isRemoteUnixListenerInvocation([
        "-c",
        "features.code_mode_host=true",
        "app-server",
        "--listen",
        "unix://",
      ]),
    ).toBe(true);
    expect(isRemoteUnixListenerInvocation(["app-server", "--listen=unix:///tmp/codex.sock"])).toBe(
      true,
    );
    expect(isRemoteUnixListenerInvocation(["app-server", "--stdio"])).toBe(false);
    expect(isRemoteUnixListenerInvocation(["app-server", "proxy"])).toBe(false);
  });

  it("converts the remote listener invocation into a per-connection stdio app-server", () => {
    expect(
      stdioArgumentsForRemoteListener([
        "-c",
        "features.code_mode_host=true",
        "app-server",
        "--listen",
        "unix://",
      ]),
    ).toEqual(["-c", "features.code_mode_host=true", "app-server", "--stdio"]);
  });

  it("uses the Codex control socket under the remote CODEX_HOME", () => {
    expect(
      remoteAppServerSocketPath({ HOME: "/Users/developer", CODEX_HOME: "/tmp/codex-home" }),
    ).toBe("/tmp/codex-home/app-server-control/app-server-control.sock");
  });

  it("bridges WebSocket text frames to one LF-delimited Host session", async () => {
    const socketPath = testSocketPath();
    const diagnosticOutput = new PassThrough();
    let received = "";
    const listener = createRemoteAppServerWebSocketListener({
      socketPath,
      diagnosticOutput,
      createSession: ({ input, output }) => ({
        async run() {
          input.setEncoding("utf8");
          for await (const chunk of input) {
            received += chunk;
            output.write(chunk);
          }
          output.end();
          return 0;
        },
      }),
    });

    try {
      await listener.listen();
      const client = new WebSocket("ws://localhost/", {
        createConnection: () => net.createConnection(socketPath),
      });
      await once(client, "open");
      client.send('{"id":1,"method":"initialize"}');
      const [message, binary] = (await once(client, "message")) as [Buffer, boolean];
      expect(binary).toBe(false);
      expect(message.toString("utf8")).toBe('{"id":1,"method":"initialize"}');
      expect(received).toBe('{"id":1,"method":"initialize"}\n');
      client.close();
      await once(client, "close");
    } finally {
      await listener.close();
      if (process.platform !== "win32") {
        await rm(path.dirname(socketPath), { recursive: true, force: true });
      }
    }
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "makes an existing control-socket directory private",
    async () => {
      const root = await mkdtemp(path.join("/tmp", "ch-mode-"));
      const socketPath = path.join(root, "control.sock");
      await chmod(root, 0o755);
      const listener = createRemoteAppServerWebSocketListener({
        socketPath,
        diagnosticOutput: new PassThrough(),
        createSession: () => ({ run: async () => 0 }),
      });

      try {
        await listener.listen();
        expect((await lstat(root)).mode & 0o777).toBe(0o700);
      } finally {
        await listener.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to place the control socket directly in a shared temporary directory",
    async () => {
      const socketPath = path.join("/tmp", `codexhost-shared-${process.pid}-${Date.now()}.sock`);
      const listener = createRemoteAppServerWebSocketListener({
        socketPath,
        diagnosticOutput: new PassThrough(),
        createSession: () => ({ run: async () => 0 }),
      });

      await expect(listener.listen()).rejects.toThrow("requires a private directory");
      await listener.close();
    },
  );
});
