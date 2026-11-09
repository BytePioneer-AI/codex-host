import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import type { RemoteHostInstallationStatus } from "../src/remote-host-install.js";
import {
  inspectRemoteHost,
  setRemoteHostLifecycleDependenciesForTest,
} from "../src/remote-host-lifecycle.js";

describe.skipIf(process.platform === "win32")("remote Host WebSocket probe", () => {
  it.each(["direct", "proxy"] as const)(
    "classifies an extension-rejecting listener through the %s connection",
    async (transport) => {
      // Keep the Unix socket path below the macOS length limit.
      const codexHome = await mkdtemp("/tmp/cxh-");
      const listenerPath = path.join(codexHome, "app-server-control", "app-server-control.sock");
      const stockCodexPath = path.join(codexHome, "stock-codex");
      const proxyScript = path.join(codexHome, "proxy.mjs");
      const proxyArguments = path.join(codexHome, "proxy-arguments.json");
      const server = createServer();
      const webSockets = new WebSocketServer({ noServer: true });
      const extensions: (string | undefined)[] = [];
      let restore: (() => void) | undefined;

      server.on("upgrade", (request, socket, head) => {
        extensions.push(request.headers["sec-websocket-extensions"]);
        // Reject the first connection to exercise the stdio proxy fallback.
        if (
          request.headers["sec-websocket-extensions"] ||
          (transport === "proxy" && extensions.length === 1)
        ) {
          socket.destroy();
          return;
        }
        webSockets.handleUpgrade(request, socket, head, (client) => {
          client.on("message", (data) => {
            const request = JSON.parse(data.toString());
            client.send(
              JSON.stringify({
                id: request.id,
                error: {
                  code: -32600,
                  message: `Invalid request: unknown variant \`${request.method}\``,
                },
              }),
            );
          });
        });
      });

      try {
        await mkdir(path.dirname(listenerPath), { recursive: true });
        await writeFile(
          stockCodexPath,
          '#!/bin/sh\nexec "$CODEXHOST_TEST_NODE" "$CODEXHOST_TEST_PROXY" "$@"\n',
          { mode: 0o755 },
        );
        await writeFile(
          proxyScript,
          `import net from "node:net";
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CODEXHOST_TEST_PROXY_ARGUMENTS, JSON.stringify(process.argv.slice(2)));
const socket = net.createConnection(process.argv[process.argv.indexOf("--sock") + 1]);
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
  process.stdin.destroy();
});
`,
        );
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(listenerPath, resolve);
        });
        const installation: RemoteHostInstallationStatus = {
          state: "ready",
          issues: [],
          format: 1,
          wrapperPath: path.join(codexHome, "codex"),
          profilePath: path.join(codexHome, ".profile"),
          stockCodexPath,
          nodePath: process.execPath,
          shimPath: path.join(codexHome, "shim"),
          hostRuntimePath: path.join(codexHome, "host-runtime.mjs"),
          dataDirectory: path.join(codexHome, "data"),
        };
        restore = setRemoteHostLifecycleDependenciesForTest({
          inspectInstallation: async () => installation,
        });

        await expect(
          inspectRemoteHost({
            environment: {
              CODEX_HOME: codexHome,
              CODEXHOST_TEST_NODE: process.execPath,
              CODEXHOST_TEST_PROXY: proxyScript,
              CODEXHOST_TEST_PROXY_ARGUMENTS: proxyArguments,
            },
          }),
        ).resolves.toMatchObject({
          runtime: { state: "conflict", protocol: "stock-codex", socketPath: listenerPath },
        });
        expect(extensions).toEqual(transport === "direct" ? [undefined] : [undefined, undefined]);
        if (transport === "proxy") {
          expect(JSON.parse(await readFile(proxyArguments, "utf8"))).toEqual([
            "app-server",
            "proxy",
            "--sock",
            listenerPath,
          ]);
        } else {
          await expect(readFile(proxyArguments)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        restore?.();
        for (const client of webSockets.clients) client.terminate();
        await new Promise<void>((resolve) => webSockets.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(codexHome, { recursive: true, force: true });
      }
    },
  );
});
