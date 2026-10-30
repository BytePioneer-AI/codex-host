import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import { GrokAcpTransport, type GrokTransportEvent } from "../src/acp-transport.js";
import type { GrokQuestionResponse } from "../src/grok-questions.js";

async function fixture(scenario: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-questions-wire-"));
  const command = path.join(root, "grok.mjs");
  const records = path.join(root, "wire.jsonl");
  await writeFile(
    command,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const scenario = process.env.QUESTION_SCENARIO;
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\\n');
let operation;
const ask = () => {
 const params = { sessionId: scenario==='foreign'?'foreign':'fixture', toolCallId:'tool-1', mode:'default',
   questions:[{question:'Choose', multiSelect:true, options:[{label:'A',description:'First'},{label:'B',description:'Second'}]}] };
 if(scenario==='malformed') params.questions = [];
 send({id:'question',method:scenario==='unknown'?'_x.ai/unsupported':'_x.ai/ask_user_question',params});
 if(scenario.startsWith('withdraw')) send({method:'_x.ai/session/update',params:{sessionId:'fixture',update:{sessionUpdate:'interaction_resolved', [scenario==='withdraw-camel'?'toolCallId':'tool_call_id']:'tool-1'}}});
};
createInterface({input:process.stdin}).on('line', line => {
 const req=JSON.parse(line);
 appendFileSync(process.env.QUESTION_RECORDS, line+'\\n');
 const reply = result => send({id:req.id,result});
 if(req.id==='question') {
   if(operation!==undefined) send({id:operation,result:scenario==='compact'?{outcome:'succeeded'}:{stopReason:'end_turn'}});
 } else if(req.method==='initialize') reply({protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{close:{}}},authMethods:[]});
 else if(req.method==='session/new' || req.method==='session/load') {
   if(scenario==='replay') ask();
   reply({sessionId:'fixture'});
   if(scenario==='idle') ask();
 } else if(req.method==='session/prompt' || req.method==='x.ai/compact_conversation') {
   operation=req.id; ask();
 } else if(req.method==='session/close') { reply({}); setTimeout(()=>process.exit(0),10); }
 else if(req.method==='_x.ai/session/info') reply({result:{sessionId:'fixture'}});
 else if(req.id!==undefined) send({id:req.id,error:{code:-32601,message:'Method not found'}});
});
`,
    { mode: 0o755 },
  );
  const transport = new GrokAcpTransport({
    command,
    cwd: root,
    environment: {
      GROK_HOME: root,
      QUESTION_SCENARIO: scenario,
      QUESTION_RECORDS: records,
    },
    commandTimeoutMs: 2000,
    closeTimeoutMs: 500,
  });
  try {
    await transport.open(
      scenario === "replay"
        ? {
            kind: "resume",
            sessionId: "fixture",
            permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
          }
        : { kind: "create", permissionModeId: harnessPermissionModeIdSchema.parse("ask") },
    );
  } catch (error) {
    await transport.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    transport,
    async response() {
      const entries = (await readFile(records, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return entries.find((entry) => entry.id === "question");
    },
    async close() {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

// POSIX executable fixture; platform-independent mapping/lifecycle tests run on Windows too.
describe.skipIf(process.platform === "win32")("Grok ACP question reverse requests", () => {
  it("dispatches the exact extension method and writes all selected labels back over ACP", async () => {
    const f = await fixture("answer");
    const onQuestion = vi.fn(async (): Promise<GrokQuestionResponse> => ({
      outcome: "accepted",
      answers: { Choose: ["A", "B"] },
    }));
    try {
      await f.transport.runTurn(
        "ask",
        () => undefined,
        async () => ({ outcome: { outcome: "cancelled" } }),
        onQuestion,
      );
      expect(onQuestion).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "fixture",
          toolCallId: "tool-1",
          questions: [expect.objectContaining({ multiple: true })],
        }),
      );
      expect(await f.response()).toMatchObject({
        result: { outcome: "accepted", answers: { Choose: ["A", "B"] } },
      });
    } finally {
      await f.close();
    }
  });

  it.each(["foreign", "malformed", "unknown", "idle", "replay", "compact"])(
    "rejects or cancels %s requests without a UI callback",
    async (scenario) => {
      const f = await fixture(scenario);
      const onQuestion = vi.fn(async (): Promise<GrokQuestionResponse> => ({
        outcome: "accepted",
        answers: {},
      }));
      try {
        if (scenario === "compact") await f.transport.compact(undefined, () => undefined);
        else if (scenario !== "idle" && scenario !== "replay")
          await f.transport.runTurn(
            "ask",
            () => undefined,
            async () => ({ outcome: { outcome: "cancelled" } }),
            onQuestion,
          );
        await expect.poll(() => f.response()).toBeDefined();
        const response = await f.response();
        if (scenario === "malformed" || scenario === "unknown")
          expect(response).toMatchObject({
            error: { code: scenario === "malformed" ? -32602 : -32601 },
          });
        else expect(response).toMatchObject({ result: { outcome: "cancelled" } });
        expect(onQuestion).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );

  it.each(["withdraw-snake", "withdraw-camel"])(
    "projects native %s resolution while an answer is pending",
    async (scenario) => {
      const f = await fixture(scenario);
      const events: GrokTransportEvent[] = [];
      let answer!: (value: GrokQuestionResponse) => void;
      try {
        const turn = f.transport.runTurn(
          "ask",
          (event) => events.push(event),
          async () => ({ outcome: { outcome: "cancelled" } }),
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        );
        await expect
          .poll(() => events)
          .toContainEqual({ type: "interaction.resolved", toolCallId: "tool-1" });
        answer({ outcome: "cancelled" });
        await turn;
        expect(await f.response()).toMatchObject({ result: { outcome: "cancelled" } });
      } finally {
        await f.close();
      }
    },
  );
});
