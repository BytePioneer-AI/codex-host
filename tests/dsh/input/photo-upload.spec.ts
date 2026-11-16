// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  BeginSubmissionInput,
  SessionFace,
} from "@deepseek-ai/dsh-api-session-controller/client";
import { ConversationController } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/service.ts";
import { preparePhoto } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/prepare-photo.ts";

vi.mock("../../../apps/web-ui/packages/client/ui-conversation/src/client/prepare-photo.ts", () => ({
  preparePhoto: vi.fn(),
}));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function fixture() {
  const ctx = new Context();
  const upload = vi.fn().mockResolvedValue({ ok: false, error: { message: "retry" } });
  ctx.provide("fileUpload", { upload } as never);
  ctx.provide("locale", { bind: () => () => "retry" } as never);
  ctx.provide("sessions", { retain: () => ({ release() {} }) } as never);
  const service = new ConversationController(ctx, {
    input: {} as never,
    blocks: {} as never,
    maxConcurrentFileUploads: 2,
  });
  cleanup.push(() => ctx.fiber.dispose());
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL() {
        return "blob:preview";
      }
      static revokeObjectURL() {}
    },
  );
  const preparation = Promise.withResolvers<File>();
  vi.mocked(preparePhoto).mockReturnValue(preparation.promise);
  const original = new File(["original"], "photo.webp", { type: "image/webp" });
  const prepared = new File(["small"], "photo.jpg", { type: "image/jpeg" });
  const draft = service.createDrafts(SessionId("one"), [original])[0]!;
  return { service, upload, preparation, original, prepared, draft };
}

it("keeps preparation uploading, permits an immediate echo and waits before admission", async () => {
  const f = fixture();
  expect(f.service.fileUploads.getSnapshot()[f.draft.id]).toEqual({
    status: "uploading",
    loaded: 0,
    total: f.original.size,
  });
  expect(f.upload).not.toHaveBeenCalled();
  let echo: BeginSubmissionInput | undefined;
  const prompt = vi.fn(async () => {
    echo?.onRetire?.({ reason: "observed", attachments: [] });
    return { ok: true, value: { accepted: true } };
  });
  const session = {
    sessionId: SessionId("one"),
    getSnapshot: () => ({ subagent: null }),
    beginSubmission: vi.fn((input: BeginSubmissionInput) => {
      echo = input;
      return { requestId: "request", abandon: vi.fn() };
    }),
    prompt,
  } as unknown as SessionFace;
  const uploaded = Promise.withResolvers<unknown>();
  f.upload.mockReturnValue(uploaded.promise);
  const sending = f.service.sendSession(session, "hello", [f.draft.id], "queue");
  expect(session.beginSubmission).toHaveBeenCalledTimes(1);
  expect(prompt).not.toHaveBeenCalled();
  f.preparation.resolve(f.prepared);
  await flush();
  expect(f.upload).toHaveBeenCalledWith(
    "one",
    f.prepared,
    "photo.jpg",
    expect.any(AbortSignal),
    expect.any(Function),
    "image/jpeg",
  );
  expect(f.service.fileUploads.getSnapshot()[f.draft.id]).toMatchObject({ total: f.prepared.size });
  expect(prompt).not.toHaveBeenCalled();
  uploaded.resolve({ ok: true, value: { receiptId: "receipt", file: {} } });
  await expect(sending).resolves.toEqual({ kind: "success" });
});

it.each(["manual", "foreground"])("%s retries reuse the prepared file", async (retry) => {
  const f = fixture();
  f.upload.mockRejectedValue(new Error("offline"));
  f.preparation.resolve(f.prepared);
  await flush();
  if (retry === "manual") f.service.retryFileUpload(SessionId("one"), f.draft.id);
  else {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  }
  await flush();
  expect(preparePhoto).toHaveBeenCalledTimes(1);
  expect(f.upload).toHaveBeenCalledTimes(2);
  expect(f.upload.mock.calls.map((call) => call[1])).toEqual([f.prepared, f.prepared]);
});

it("removing an attachment during preparation never starts an upload", async () => {
  const f = fixture();
  f.service.releaseDraftAttachment(f.draft.id);
  f.preparation.resolve(f.prepared);
  await flush();
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.service.fileUploads.getSnapshot()[f.draft.id]).toBeUndefined();
});

it("rebind during preparation shares the result and uploads only to the new Session", async () => {
  const f = fixture();
  f.service.rebindDraftFiles(SessionId("two"), [f.draft.id]);
  f.preparation.resolve(f.prepared);
  await flush();
  expect(preparePhoto).toHaveBeenCalledTimes(1);
  expect(f.upload).toHaveBeenCalledTimes(1);
  expect(f.upload.mock.calls[0]?.[0]).toBe("two");
});

it("a fallback original is also reused on retry", async () => {
  const f = fixture();
  f.preparation.resolve(f.original);
  await flush();
  f.service.retryFileUpload(SessionId("one"), f.draft.id);
  await flush();
  expect(preparePhoto).toHaveBeenCalledTimes(1);
  expect(f.upload.mock.calls.map((call) => call[1])).toEqual([f.original, f.original]);
  expect(f.upload.mock.calls[1]?.[5]).toBe("image/webp");
});
