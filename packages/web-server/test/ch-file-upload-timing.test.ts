import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ChFileInputs } from "../src/ch-file-inputs.ts";
import { serveFileUpload } from "../src/ch-file-upload-http.ts";
import { DataDir } from "../src/store.ts";
import { WebFiles } from "../src/web-files.ts";
import { WebImages } from "../src/web-images.ts";
import { PNG } from "./support/image.ts";

it("reports upload ownership, intake/storage and trusted ingress timings without file or credential metadata", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "upload-timing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root);
  const images = new WebImages(data);
  const files = new WebFiles(data, images);
  let now = 0;
  t.mock.method(performance, "now", () => now);
  let ownerCalls = 0;
  let rejectAfter = false;
  const inputs = new ChFileInputs(files, images, async (id) => {
    now += ++ownerCalls % 2 ? 20 : 30;
    if (rejectAfter && ownerCalls % 2 === 0) throw new Error("owner unavailable");
    return id;
  });
  const upload = files.upload.bind(files);
  t.mock.method(files, "upload", async (...args: Parameters<typeof upload>) => {
    const value = await upload(...args);
    now += 10;
    return value;
  });
  const logs: string[] = [];
  t.mock.method(console, "info", (line: string) => logs.push(line));
  let viaRelay = false;
  const server = createServer((request, response) => {
    void serveFileUpload(
      { uploadFile: (...args) => inputs.upload(...args) },
      request,
      response,
      viaRelay,
    );
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const body = Buffer.from(PNG, "base64");
  for (const relay of [false, true]) {
    viaRelay = relay;
    rejectAfter = relay;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/session/uploadFileBinary?sessionId=thread&name=private.png&imageMediaType=image%2Fpng`,
      {
        method: "POST",
        body,
        headers: {
          "content-type": "application/octet-stream",
          authorization: "Bearer private-token",
        },
      },
    );
    assert.equal((await response.json()).ok, !rejectAfter);
    const line = logs.at(-1);
    assert.ok(line);
    assert.ok(line.startsWith("[uploadFileBinary] "));
    assert.ok(!line.includes("private") && !line.includes(root));
    const timing = JSON.parse(line.slice("[uploadFileBinary] ".length));
    assert.deepEqual(timing, {
      sessionId: "thread",
      bytes: body.length,
      viaRelay: relay,
      httpVersion: "1.1",
      ok: !rejectAfter,
      totalMs: 60,
      firstByteMs: 20,
      bodyEndMs: 20,
      ownerBeforeMs: 20,
      receiveStoreMs: 10,
      ownerAfterMs: 30,
    });
  }
});
