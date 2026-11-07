import assert from "node:assert/strict";
import { defined } from "./support/defined.ts";
import { once } from "node:events";
import { request } from "node:https";
import { it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { WebSocket } from "ws";
import { webToolOutputPreviews } from "@codexhost/shared-contracts";
import { toolOutputRelay } from "./support/tool-output-relay.ts";

it(
  "uses actual relay TLS provenance for browser follow/page and authenticates full reads",
  { timeout: 30_000 },
  async (t) => {
    const f = await toolOutputRelay(t);
    const send = (method: string, args: object, token: string | undefined = f.secret) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            hostname: "localhost",
            port: f.relay.port,
            servername: f.hostname,
            path: `/api/${method}`,
            method: "POST",
            agent: false,
            headers: {
              host: f.hostname,
              origin: f.origin,
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
          },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => resolve({ status: defined(response.statusCode), body }));
          },
        );
        req.on("error", reject);
        req.end(
          JSON.stringify({ type: "client-request", rpcId: "test", method, payload: { args } }),
        );
      });
    interface Frame {
      cursor: number;
      epoch: string;
      resumedAfter?: number;
      records: Array<{
        event: {
          type: string;
          data: { meta?: unknown; message: { content: Array<{ text: string }> } };
        };
      }>;
    }
    const open = async (relay: boolean, resume?: { epoch: string; cursor: number }) => {
      const ws = relay
        ? new WebSocket(`wss://localhost:${f.relay.port}/api/remote.mux`, {
            servername: f.hostname,
            headers: { host: f.hostname, origin: f.origin, authorization: `Bearer ${f.secret}` },
          } as WebSocket.ClientOptions)
        : new WebSocket(`ws://${f.local.host}/api/remote.mux`, {
            headers: {
              authorization: `Bearer ${f.secret}`,
              "x-forwarded-proto": "https",
              "x-forwarded-host": f.hostname,
            },
          });
      t.after(() => ws.terminate());
      await once(ws, "open");
      const received = once(ws, "message");
      ws.send(
        JSON.stringify({
          type: "open",
          streamId: "history",
          endpoint: "session/follow",
          payload: {
            args: {
              request: {
                address: { sessionId: f.row.id },
                assistantStream: true,
                ...(resume ? { resume } : {}),
              },
            },
          },
        }),
      );
      const frame = JSON.parse(String((await received)[0])).value as Frame;
      ws.close();
      await once(ws, "close");
      return frame;
    };
    const full = await open(false),
      preview = await open(true);
    const result = defined(preview.records.find((r) => r.event.type === "tool/result"));
    const reference = defined(webToolOutputPreviews(result.event.data.meta)[0]).reference;
    const localText = defined(
      defined(full.records.find((r) => r.event.type === "tool/result")).event.data.message
        .content[0],
    ).text;
    assert.equal(defined(result.event.data.message.content[0]).text.length, 8192);
    assert.ok(localText.length >= 100_000);
    const bytes = (frame: Frame) => {
      const json = JSON.stringify(frame);
      return { json: Buffer.byteLength(json), deflate: deflateRawSync(json, { level: 3 }).length };
    };
    console.log(
      "RELAY_FIRST_SCREEN_BYTES",
      JSON.stringify({ before: bytes(full), after: bytes(preview) }),
    );
    const unchanged = await open(true, { epoch: preview.epoch, cursor: preview.cursor });
    assert.equal(unchanged.resumedAfter, preview.cursor);
    assert.equal(unchanged.records.length, 0);
    const loaded = await send("session/toolOutput", { request: reference });
    assert.equal(loaded.status, 200);
    assert.equal(JSON.parse(loaded.body).result.value.text, localText);
    assert.equal((await send("session/toolOutput", { request: reference }, "")).status, 401);
    const stale = await send("session/toolOutput", { request: { ...reference, version: "stale" } });
    assert.equal(JSON.parse(stale.body).result.error.code, "session/tool-output-stale");
    const foreign = await send("session/toolOutput", {
      request: { ...reference, sessionId: "other-thread" },
    });
    assert.equal(JSON.parse(foreign.body).result.error.code, "session/tool-output-stale");
    const page = await send("session/page", {
      request: { address: { sessionId: f.row.id }, throughSeq: preview.cursor },
    });
    assert.ok(
      webToolOutputPreviews(
        JSON.parse(page.body).result.value.records.find(
          (r: { event: { type: string } }) => r.event.type === "tool/result",
        ).event.data.meta,
      ).length > 0,
    );
    // A caller cannot select preview mode with a logical request or forwarding headers.
    const direct = await fetch(new URL("/api/session/page", f.local), {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.secret}`,
        "x-forwarded-host": f.hostname,
        "x-codexhost-relay": "true",
      },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "direct",
        method: "session/page",
        payload: {
          args: {
            relay: true,
            request: { address: { sessionId: f.row.id }, throughSeq: full.cursor },
          },
        },
      }),
    });
    const directPage = await direct.json();
    assert.equal(direct.status, 200);
    assert.equal(
      directPage.result.value.records.find(
        (r: { event: { type: string } }) => r.event.type === "tool/result",
      ).event.data.message.content[0].text,
      localText,
    );
    await fetch(new URL("/api/codexhost/accessTokenRegenerate", f.local), {
      method: "POST",
      headers: { authorization: `Bearer ${f.localToken}` },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "revoke",
        method: "codexhost/accessTokenRegenerate",
        payload: { args: {} },
      }),
    });
    assert.equal((await send("session/toolOutput", { request: reference })).status, 401);
  },
);
