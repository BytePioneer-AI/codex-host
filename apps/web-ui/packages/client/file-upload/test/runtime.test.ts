import assert from "node:assert/strict";
import { openAsBlob } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
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
  const bytes = Uint8Array.from([0, 255, 1, 42]);
  const ordinaryFile = new File([bytes], "original.bin");
  scope.__DSH_FILE_UPLOAD__ = {
    fetch: async (url, init) => {
      assert.match(String(url), /^api\/session\/uploadFileBinary\?/u);
      assert.equal(
        init?.headers && (init.headers as Record<string, string>)["content-type"],
        "application/octet-stream",
      );
      if (new URL(String(url), "http://localhost/").searchParams.get("name") === ordinaryFile.name)
        assert.equal(init?.body, ordinaryFile);
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
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  for (const body of [new Blob([bytes]), bytes, stream, ordinaryFile]) {
    const result = await runtime.upload(
      "thread" as never,
      body,
      body instanceof File ? body.name : "data.bin",
    );
    assert.ok(result.ok);
  }
  assert.equal(bodies.length, 4);
  for (const body of bodies) assert.deepEqual(body, bytes);
});

it("declares image uploads explicitly and keeps transport failures distinct from business refusals", async (t) => {
  const scope = globalThis as typeof globalThis & { __DSH_FILE_UPLOAD__?: { fetch: typeof fetch } };
  const previous = scope.__DSH_FILE_UPLOAD__;
  t.after(() => {
    if (previous) scope.__DSH_FILE_UPLOAD__ = previous;
    else delete scope.__DSH_FILE_UPLOAD__;
  });
  let status = 503;
  scope.__DSH_FILE_UPLOAD__ = {
    fetch: async (path) => {
      assert.equal(
        new URL(String(path), "http://localhost/").searchParams.get("imageMediaType"),
        "image/png",
      );
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "session/attachment-invalid",
            message: "Invalid image",
            details: { reason: "INVALID_IMAGE" },
          },
        }),
        { status },
      );
    },
  };
  const runtime = new FileUploadRuntime(new Context());
  const send = () =>
    runtime.upload(
      "thread" as never,
      new Blob(["image"]),
      "photo.png",
      undefined,
      undefined,
      "image/png",
    );
  await assert.rejects(send(), /HTTP 503/u);
  status = 200;
  const rejected = await send();
  assert.equal(rejected.ok, false);
});

it("uploads the bytes of a dropped image even when its source goes away during transport", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "dropped-image-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, "photo.png");
  const bytes = Uint8Array.of(0, 255, 1, 42);
  await writeFile(path, bytes);
  const file = new File([await openAsBlob(path)], "photo.png", { type: "image/png" });
  const scope = globalThis as typeof globalThis & { __DSH_FILE_UPLOAD__?: { fetch: typeof fetch } };
  const previous = scope.__DSH_FILE_UPLOAD__;
  t.after(() => {
    if (previous) scope.__DSH_FILE_UPLOAD__ = previous;
    else delete scope.__DSH_FILE_UPLOAD__;
  });
  scope.__DSH_FILE_UPLOAD__ = {
    fetch: async (url, init) => {
      await rm(path);
      const query = new URL(String(url), "http://localhost/").searchParams;
      assert.equal(query.get("name"), file.name);
      assert.equal(query.get("imageMediaType"), file.type);
      assert.ok(init?.body instanceof Blob);
      assert.equal(init.body.type, file.type);
      assert.deepEqual(new Uint8Array(await init.body.arrayBuffer()), bytes);
      return Response.json({
        ok: true,
        value: { receiptId: "receipt", file: { attachmentId: "image", name: file.name, bytes: 4 } },
      });
    },
  };
  const runtime = new FileUploadRuntime(new Context());
  const result = await runtime.upload(
    "thread" as never,
    file,
    file.name,
    undefined,
    undefined,
    file.type,
  );
  assert.ok(result.ok);
});

for (const stop of ["remove", "timeout"] as const) {
  it(`releases a stalled image read on ${stop} after allowing slow progress`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController();
    const file = new File(["abc"], "slow.png", { type: "image/png" });
    let source!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(reader) {
        source = reader;
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    t.mock.method(file, "stream", () => stream);
    const runtime = new FileUploadRuntime(new Context());
    const upload = runtime.upload(
      "thread" as never,
      file,
      file.name,
      controller.signal,
      undefined,
      file.type,
    );
    const rejected = assert.rejects(
      upload,
      stop === "remove" ? { name: "AbortError" } : /60 seconds/u,
    );
    t.mock.timers.tick(45_000);
    source.enqueue(Uint8Array.of(1));
    await nextTick();
    t.mock.timers.tick(59_999);
    assert.equal(cancelled, false);
    if (stop === "remove") controller.abort();
    else t.mock.timers.tick(1);
    await rejected;
    assert.equal(cancelled, true);
  });
}
