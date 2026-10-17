import assert from "node:assert/strict";
import { it } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { FileUploadRuntime } from "../src/client/runtime.ts";

it("Blob, Uint8Array and stream carriers all bypass the JSON RPC file-size ceiling", async (t) => {
  const scope = globalThis as typeof globalThis & { __DSH_FILE_UPLOAD__?: { fetch: typeof fetch } };
  const previous = scope.__DSH_FILE_UPLOAD__;
  t.after(() => {
    if (previous) scope.__DSH_FILE_UPLOAD__ = previous;
    else delete scope.__DSH_FILE_UPLOAD__;
  });
  const bodies: Uint8Array[] = [];
  scope.__DSH_FILE_UPLOAD__ = {
    fetch: async (url, init) => {
      assert.match(String(url), /^api\/session\/uploadFileBinary\?/u);
      assert.equal(
        init?.headers && (init.headers as Record<string, string>)["content-type"],
        "application/octet-stream",
      );
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      bodies.push(bytes);
      return new Response(
        JSON.stringify({
          ok: true,
          value: {
            receiptId: "receipt",
            file: { attachmentId: "file", name: "data.bin", bytes: bytes.length },
          },
        }),
      );
    },
  };
  // No Remote service is supplied; the old Uint8Array fallback would fail here.
  const runtime = new FileUploadRuntime(new Context());
  const bytes = Uint8Array.from([0, 255, 1, 42]);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  for (const body of [new Blob([bytes]), bytes, stream]) {
    const result = await runtime.upload("thread" as never, body, "data.bin");
    assert.ok(result.ok);
  }
  assert.equal(bodies.length, 3);
  for (const body of bodies) assert.deepEqual(body, bytes);
});
