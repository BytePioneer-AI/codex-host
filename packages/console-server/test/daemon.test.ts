import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createConsoleDaemon } from "../src/daemon.js";

const require = createRequire(import.meta.url);

describe("console daemon restart", () => {
  it("waits for the previous process to release its lock after its listener closes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "console-daemon-restart-"));
    const runtime = path.join(root, "runtime.mjs");
    await writeFile(
      runtime,
      `
      import fs from "node:fs";
      import path from "node:path";
      import ws from ${JSON.stringify(pathToFileURL(require.resolve("ws")).href)};
      const { WebSocketServer } = ws;
      const root = process.env.TEST_DAEMON_ROOT;
      const lock = path.join(root, "owner.lock");
      fs.closeSync(fs.openSync(lock, "wx"));
      const descriptor = path.join(root, "runtime.json");
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      server.on("listening", () => fs.writeFileSync(descriptor, JSON.stringify({
        schemaVersion: 1, protocolVersion: 1, pid: process.pid,
        host: "127.0.0.1", port: server.address().port, token: "test", startedAt: Date.now(),
      })));
      process.on("SIGTERM", () => {
        fs.rmSync(descriptor, { force: true });
        server.close();
        setTimeout(() => { fs.rmSync(lock); process.exit(0); }, 300);
      });
    `,
    );
    const daemon = createConsoleDaemon({
      appDirectory: root,
      dataDirectory: root,
      logsDirectory: root,
      environment: { ...process.env, CODEXHOST_HOST_RUNTIME_PATH: runtime, TEST_DAEMON_ROOT: root },
    });
    try {
      const first = await daemon.start();
      const second = await daemon.restart();
      expect(second.running).toBe(true);
      expect(second.pid).not.toBe(first.pid);
    } finally {
      await daemon.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
