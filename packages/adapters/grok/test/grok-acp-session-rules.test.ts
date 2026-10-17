import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { GrokAcpTransport } from "../src/acp-transport.js";
import {
  GROK_CODEXHOST_SESSION_RULES,
  grokCodexhostSessionMeta,
} from "../src/grok-codexhost-session-rules.js";

const permissionModeId = (id: "ask" | "auto" | "always-approve") =>
  harnessPermissionModeIdSchema.parse(id);

async function capturedMeta(
  root: string,
  open: Parameters<GrokAcpTransport["open"]>[0],
): Promise<Record<string, unknown>[]> {
  const command = path.join(root, "fixture.mjs");
  const capture = path.join(root, `captured-${randomUUID()}.jsonl`);
  await writeFile(
    command,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const capture = process.env.CODEXHOST_ACP_CAPTURE;
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'session/new' || request.method === 'session/load') {
    appendFileSync(capture, JSON.stringify({method:request.method, params:request.params})+'\\n');
  }
  if (request.method === 'initialize') {
    send({id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
  } else if (request.method === 'session/new') {
    send({id:request.id,result:{sessionId:'created'}});
  } else if (request.method === 'session/load') {
    send({id:request.id,result:{sessionId:request.params.sessionId}});
  } else if (request.method === '_x.ai/session/fork') {
    send({id:request.id,result:{newSessionId:'forked',parentSessionId:request.params.sourceSessionId}});
  } else if (request.method === '_x.ai/rewind/execute') {
    send({id:request.id,result:{success:true,targetPromptIndex:request.params.targetPromptIndex}});
  }
});
`,
    { mode: 0o755 },
  );
  const transport = new GrokAcpTransport({
    cwd: root,
    command,
    environment: { HOME: root, GROK_HOME: root, CODEXHOST_ACP_CAPTURE: capture },
    commandTimeoutMs: 3000,
    closeTimeoutMs: 100,
  });
  try {
    await transport.open(open);
  } finally {
    await transport.close();
  }
  const text = await readFile(capture, "utf8");
  return text
    .trim()
    .split("\n")
    .map(
      (line) => JSON.parse(line) as { method: string; params: { _meta?: Record<string, unknown> } },
    )
    .map((entry) => entry.params._meta ?? {});
}

describe.skipIf(process.platform === "win32")("Grok ACP session rules wire", () => {
  it("sends _meta.rules on create, resume, fork-load, and rewind-load", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-acp-session-rules-"));
    try {
      const createAsk = await capturedMeta(root, {
        kind: "create",
        permissionModeId: permissionModeId("ask"),
      });
      const createAuto = await capturedMeta(root, {
        kind: "create",
        permissionModeId: permissionModeId("auto"),
      });
      const createAlways = await capturedMeta(root, {
        kind: "create",
        permissionModeId: permissionModeId("always-approve"),
      });
      const resumeAsk = await capturedMeta(root, {
        kind: "resume",
        sessionId: "resume-ask",
        permissionModeId: permissionModeId("ask"),
      });
      const resumeAuto = await capturedMeta(root, {
        kind: "resume",
        sessionId: "resume-auto",
        permissionModeId: permissionModeId("auto"),
      });
      const resumeAlways = await capturedMeta(root, {
        kind: "resume",
        sessionId: "resume-always",
        permissionModeId: permissionModeId("always-approve"),
      });
      const forkLoad = await capturedMeta(root, {
        kind: "fork",
        sourceSessionId: "source",
        sourceCwd: root,
        targetPromptIndex: 0,
      });
      const rewindLoad = await capturedMeta(root, {
        kind: "rewind",
        sessionId: "rewind",
        targetPromptIndex: 0,
      });

      expect(createAsk).toEqual([grokCodexhostSessionMeta("ask")]);
      expect(createAuto).toEqual([grokCodexhostSessionMeta("auto")]);
      expect(createAlways).toEqual([grokCodexhostSessionMeta("always-approve")]);
      expect(resumeAsk).toEqual([grokCodexhostSessionMeta("ask")]);
      expect(resumeAuto).toEqual([grokCodexhostSessionMeta("auto")]);
      expect(resumeAlways).toEqual([grokCodexhostSessionMeta("always-approve")]);
      expect(forkLoad).toEqual([grokCodexhostSessionMeta()]);
      expect(rewindLoad).toEqual([grokCodexhostSessionMeta()]);
      expect(forkLoad[0]?.yoloMode).toBeUndefined();
      expect(rewindLoad[0]?.autoMode).toBeUndefined();
      expect(createAsk[0]?.rules).toBe(GROK_CODEXHOST_SESSION_RULES);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
