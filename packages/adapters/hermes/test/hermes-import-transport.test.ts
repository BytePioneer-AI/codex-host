import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HermesAdapter } from "../src/hermes-adapter.js";
import { HermesGatewayTransport } from "../src/gateway-transport.js";

// The retained ACP path must stay query-only and independent of chat discovery.
describe("Hermes import discovery ACP isolation", () => {
  it.skipIf(process.platform === "win32").each([1, 999])(
    "keeps initialize + session/list at protocolVersion %i",
    async (version) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "hermes-import-protocol-"));
      const command = path.join(root, "hermes");
      const log = path.join(root, "requests.log");
      await writeFile(
        command,
        `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
readline.createInterface({input: process.stdin}).on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, request.method + "\\n");
  const result = request.method === "initialize" ? {protocolVersion: ${version}} : {sessions: [
    {sessionId: "native-stored", cwd: ${JSON.stringify(root)}, title: "Native title", updatedAt: 1700000000000, running: false},
    {sessionId: "invalid", updatedAt: "bad date"}
  ]};
  process.stdout.write(JSON.stringify({jsonrpc: "2.0", id: request.id, result}) + "\\n");
});
`,
      );
      await chmod(command, 0o755);
      const gateway = vi.spyOn(HermesGatewayTransport, "probe");
      const adapter = new HermesAdapter({ command, closeTimeoutMs: 100 });
      try {
        expect(await adapter.sessionImport.listCandidates()).toEqual({
          ok: true,
          value: [
            {
              nativeSessionId: "native-stored",
              title: "Native title",
              cwd: root,
              updatedAt: 1700000000000,
              running: false,
            },
          ],
        });
        expect(await adapter.sessionImport.resolveCandidate("native-stored")).toMatchObject({
          ok: true,
          value: {
            nativeRef: { harnessId: "hermes", nativeSessionId: "native-stored", formatVersion: 1 },
          },
        });
        expect(gateway).not.toHaveBeenCalled();
        expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
          "initialize",
          "session/list",
          "initialize",
          "session/list",
        ]);
      } finally {
        await adapter.close();
        gateway.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
