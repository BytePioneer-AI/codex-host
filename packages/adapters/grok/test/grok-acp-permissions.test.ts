import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { GrokAcpTransport } from "../src/acp-transport.js";

async function fixture(scenario: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-acp-permissions-"));
  const command = path.join(root, "grok.mjs");
  const records = path.join(root, "requests.jsonl");
  await writeFile(
    command,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const scenario = process.env.GROK_PERMISSION_SCENARIO;
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const log = (message) => process.stderr.write('2026-10-23T02:24:56.741602Z  INFO '+message+'\\n');
let changed = false;
createInterface({input:process.stdin}).on('line', line => {
 const req = JSON.parse(line);
 appendFileSync(process.env.GROK_PERMISSION_RECORDS, line+'\\n');
 const reply = result => send({id:req.id,result});
 if(req.method==='initialize') reply({protocolVersion:1,agentCapabilities:{sessionCapabilities:{close:{}}},authMethods:[]});
 else if(req.method==='session/new') reply({sessionId:'fixture'});
 else if(req.method==='_x.ai/yolo_mode_changed') {
  changed = true;
  const p = req.params;
  if(scenario==='exit') { process.exit(1); return; }
  if(scenario==='silent' || scenario==='close-hang') return;
  if(!process.env.RUST_LOG.includes('xai_grok_workspace::permission::manager=info')) return;
  const yolo = scenario==='clamp-yolo' ? false : p.yolo_mode;
  const auto = scenario==='clamp-auto' ? false : p.auto_mode;
  setTimeout(() => log('always-approve set to: '+yolo), 20);
  if(scenario!=='partial') setTimeout(() => log('auto permission mode set to: '+auto), 50);
 }
 else if(req.method==='_x.ai/session/info') {
  if(!changed) throw new Error('must send notification before confirmation barrier');
  setTimeout(() => reply({result:{sessionId:scenario==='foreign'?'foreign':'fixture'}}), 90);
 }
 else if(req.method==='session/close') { if(scenario!=='close-hang') reply({}); }
 else if(req.id!==undefined) send({id:req.id,error:{code:-32601,message:'Method not found'}});
});
`,
    { mode: 0o755 },
  );
  const fault = vi.fn();
  const transport = new GrokAcpTransport({
    command,
    cwd: root,
    environment: {
      GROK_HOME: root,
      GROK_PERMISSION_SCENARIO: scenario,
      GROK_PERMISSION_RECORDS: records,
      RUST_LOG: "warn",
    },
    commandTimeoutMs: 2_000,
    closeTimeoutMs: 50,
    onFault: fault,
  });
  try {
    await transport.open({
      kind: "create",
      permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
    });
  } catch (error) {
    await transport.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    transport,
    fault,
    requests: async () =>
      (await readFile(records, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    close: async () => {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

// The executable fixture uses a POSIX shebang, as the other ACP wire fixtures do.
describe.skipIf(process.platform === "win32")("Grok ACP permission wire", () => {
  it("uses the extension prefix, confirms every mode and preserves Session identity", async () => {
    const f = await fixture("success");
    try {
      for (const mode of ["ask", "always-approve", "auto", "ask"] as const) {
        let settled = false;
        const selection = f.transport
          .setPermissionMode(harnessPermissionModeIdSchema.parse(mode))
          .then(() => {
            settled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(settled).toBe(false);
        await selection;
        expect(f.transport.sessionId).toBe("fixture");
      }
      const requests = await f.requests();
      expect(
        requests.filter((r) => r.method === "_x.ai/yolo_mode_changed").map((r) => r.params),
      ).toEqual([
        { yolo_mode: false, auto_mode: false, permission_mode: "ask" },
        { yolo_mode: true, auto_mode: false, permission_mode: "always-approve" },
        { yolo_mode: false, auto_mode: true, permission_mode: "auto" },
        { yolo_mode: false, auto_mode: false, permission_mode: "ask" },
      ]);
      expect(requests.filter((r) => r.method === "session/new")).toHaveLength(1);
      expect(requests.some((r) => r.method === "session/prompt")).toBe(false);
      expect(f.fault).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it.each([
    ["silent", "auto"],
    ["partial", "auto"],
    ["clamp-yolo", "always-approve"],
    ["clamp-auto", "auto"],
    ["foreign", "auto"],
    ["exit", "auto"],
  ] as const)("fails and retires the Transport on %s confirmation", async (scenario, mode) => {
    const f = await fixture(scenario);
    try {
      await expect(
        f.transport.setPermissionMode(harnessPermissionModeIdSchema.parse(mode)),
      ).rejects.toThrow("could not be confirmed");
      expect(f.fault).toHaveBeenCalled();
      await expect(
        f.transport.setPermissionMode(harnessPermissionModeIdSchema.parse("ask")),
      ).rejects.toThrow("unavailable");
    } finally {
      await f.close();
    }
  });

  it.each(["silent", "close-hang"])(
    "aborts pending confirmation even if close is %s",
    async (scenario) => {
      const f = await fixture(scenario);
      try {
        const selection = expect(
          f.transport.setPermissionMode(harnessPermissionModeIdSchema.parse("auto")),
        ).rejects.toThrow("could not be confirmed");
        await expect(
          f.transport.setPermissionMode(harnessPermissionModeIdSchema.parse("ask")),
        ).rejects.toThrow("active operation");
        await expect(f.transport.setModel("fixture")).rejects.toThrow("active operation");
        await expect(f.transport.compact(undefined, () => undefined)).rejects.toThrow(
          "active operation",
        );
        await expect(
          f.transport.runTurn(
            "blocked",
            () => undefined,
            async () => ({
              outcome: { outcome: "cancelled" },
            }),
          ),
        ).rejects.toThrow("active operation");
        const closing = f.transport.close();
        expect(f.transport.close()).toBe(closing);
        await closing;
        await selection;
      } finally {
        await f.close();
      }
    },
  );
});
