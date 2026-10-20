import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { GrokAcpTransport } from "../src/acp-transport.js";

// The executable fixture uses a POSIX shebang.
describe.skipIf(process.platform === "win32")("Grok ACP model configuration", () => {
  it.each([
    { effort: "high", contextWindow: undefined },
    { effort: "max", contextWindow: undefined },
    { effort: "high", contextWindow: 500000 },
    { effort: "max", contextWindow: 500000 },
    { effort: undefined, contextWindow: 500000 },
    { effort: undefined, contextWindow: undefined },
  ])("sends native metadata for $effort / $contextWindow", async ({ effort, contextWindow }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-acp-model-"));
    const command = path.join(root, "fixture.mjs");
    await writeFile(
      command,
      `#!${process.execPath}
import { createInterface } from 'node:readline';
const expected = ${JSON.stringify({ effort, contextWindow })};
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (request.method === 'session/new') send({ id: request.id, result: { sessionId: 'fixture' } });
  else if (request.method === 'session/set_model') {
    const { params } = request;
    const valid = params.sessionId === 'fixture' && params.modelId === 'deepseek-v4-flash'
      && !Object.hasOwn(params, 'reasoningEffort')
      && params._meta?.reasoningEffort === expected.effort
      && params._meta?.contextWindow === expected.contextWindow;
    send({ id: request.id, result: { _meta: { model: valid ? { Ok: params.modelId } : { Err: 'Invalid native metadata' } } } });
  }
});
`,
      { mode: 0o755 },
    );
    const transport = new GrokAcpTransport({
      cwd: root,
      command,
      environment: { HOME: root, GROK_HOME: root },
      commandTimeoutMs: 3000,
      closeTimeoutMs: 100,
    });
    try {
      await transport.open({
        kind: "create",
        permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
      });
      await expect(
        transport.setModel("deepseek-v4-flash", effort, contextWindow),
      ).resolves.toBeUndefined();
    } finally {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
