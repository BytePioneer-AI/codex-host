// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  SessionFace,
  BeginSubmissionInput,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { FileUploadValue } from "../../../apps/web-ui/packages/client/file-upload/src/types.ts";
import { ConversationController } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/service.ts";
import { SessionInputShell } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/input/facade.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.unstubAllGlobals();
});
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

function fixture() {
  const ctx = new Context();
  const uploads: Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    sessionId: string;
    mediaType?: string;
  }> = [];
  const upload = vi.fn(
    (
      sessionId: string,
      _file: File,
      _name: string,
      _signal: AbortSignal,
      _progress: unknown,
      mediaType?: string,
    ) =>
      new Promise((resolve, reject) => {
        uploads.push({ resolve, reject, sessionId, mediaType });
      }),
  );
  const release = vi.fn();
  ctx.provide("fileUpload", { upload } as never);
  ctx.provide("locale", {
    bind: () => () => "Retry or remove failed attachments before sending",
  } as never);
  ctx.provide("sessions", { retain: () => ({ release }) } as never);
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
  const drafts = service.createDrafts(SessionId("one"), [
    new File(["image"], "photo.png", { type: "image/png" }),
    new File(["file"], "notes.txt"),
  ]);
  let echo: BeginSubmissionInput | undefined;
  const abandon = vi.fn();
  const prompt = vi.fn(async () => {
    echo?.onRetire?.({ reason: "observed", attachments: [] });
    return { ok: true, value: { accepted: true } };
  });
  const session = {
    sessionId: SessionId("one"),
    getSnapshot: () => ({ subagent: null }),
    beginSubmission: vi.fn((input: BeginSubmissionInput) => {
      echo = input;
      return { requestId: "request", abandon };
    }),
    prompt,
  } as unknown as SessionFace;
  const ready = (index: number) =>
    uploads[index]!.resolve({
      ok: true,
      value: {
        receiptId: `receipt-${index}`,
        file: { attachmentId: `file-${index}`, name: drafts[index]?.file.name, bytes: 5 },
      } as unknown as FileUploadValue,
    });
  return { service, drafts, uploads, session, prompt, abandon, release, ready, echo: () => echo };
}

it.each(["queue", "steer"] as const)(
  "echoes %s immediately and waits for every image/file receipt before prompting",
  async (mode) => {
    const f = fixture();
    expect(f.uploads.map((item) => item.mediaType)).toEqual(["image/png", undefined]);
    const pending = f.service.sendSession(
      f.session,
      "hello",
      f.drafts.map((item) => item.id),
      mode,
    );
    expect(f.session.beginSubmission).toHaveBeenCalledTimes(1);
    expect(f.echo()?.attachments.map((item) => item.type)).toEqual(["image", "file"]);
    expect(f.prompt).not.toHaveBeenCalled();
    f.ready(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    f.ready(1);
    await expect(pending).resolves.toEqual({ kind: "success" });
    expect(f.prompt).toHaveBeenCalledWith(
      [
        { type: "file", receiptId: "receipt-0" },
        { type: "file", receiptId: "receipt-1" },
        { type: "text", text: "hello" },
      ],
      mode,
      undefined,
      "request",
    );
    expect(f.release).toHaveBeenCalledTimes(1);
  },
);

it("serializes command attachments only after upload and submits already-ready receipts without upload work", async () => {
  const f = fixture();
  let serialized = false;
  const command = f.service
    .serializeDraftAttachments(f.drafts.map((item) => item.id))
    .then((value) => {
      serialized = true;
      return value;
    });
  await flush();
  expect(serialized).toBe(false);
  f.ready(0);
  f.ready(1);
  expect((await command).attachments).toEqual([
    { type: "file", receiptId: "receipt-0" },
    { type: "file", receiptId: "receipt-1" },
  ]);
  await expect(
    f.service.sendSession(
      f.session,
      "ready",
      f.drafts.map((item) => item.id),
      "queue",
    ),
  ).resolves.toEqual({ kind: "success" });
  expect(f.uploads).toHaveLength(2);
});

it("abandons the whole echo on upload failure, retains every draft, and blocks failed drafts before a new echo", async () => {
  const f = fixture();
  const sending = f.service.sendSession(
    f.session,
    "keep",
    f.drafts.map((item) => item.id),
    "queue",
  );
  const rejected = expect(sending).rejects.toThrow("Retry or remove");
  f.uploads[0]!.reject(new Error("network"));
  await rejected;
  expect(f.abandon).toHaveBeenCalledTimes(1);
  expect(f.prompt).not.toHaveBeenCalled();
  expect(f.service.resolveDraftAttachments(f.drafts.map((item) => item.id))).toHaveLength(2);
  await expect(
    f.service.sendSession(
      f.session,
      "again",
      f.drafts.map((item) => item.id),
      "queue",
    ),
  ).rejects.toThrow("Retry or remove");
  expect(f.session.beginSubmission).toHaveBeenCalledTimes(1);
  f.ready(1);
});

it("settles a waiting command serialization when its draft is released", async () => {
  const f = fixture();
  const command = f.service.serializeDraftAttachments(f.drafts.map((item) => item.id));
  const rejected = expect(command).rejects.toThrow("Retry or remove");
  f.service.releaseDraftAttachment(f.drafts[0]!.id);
  await rejected;
  f.ready(0);
  f.ready(1);
  expect(f.prompt).not.toHaveBeenCalled();
});

it("retries transport failures once on foreground but not explicit rejections", async () => {
  const f = fixture();
  f.uploads[0]!.reject(new Error("offline"));
  f.uploads[1]!.resolve({ ok: false, error: { message: "rejected" } });
  await flush();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(f.uploads).toHaveLength(2);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(f.uploads).toHaveLength(3);
  expect(f.uploads[2]?.sessionId).toBe("one");
  expect(f.uploads[2]?.mediaType).toBe("image/png");
  f.uploads[2]!.reject(new Error("still offline"));
  await flush();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(f.uploads).toHaveLength(3);
  f.service.retryFileUpload(SessionId("one"), f.drafts[0]!.id);
  expect(f.uploads).toHaveLength(4);
  f.uploads[3]!.resolve({ ok: false, error: { message: "rejected" } });
});

it("releases a stalled concurrency slot on timeout and starts the next queued attachment", async () => {
  const f = fixture();
  const [third] = f.service.createDrafts(SessionId("one"), [new File(["third"], "third.txt")]);
  expect(f.uploads).toHaveLength(2);
  await flush();
  expect(f.uploads).toHaveLength(2, "two unfinished uploads occupy both slots");
  f.uploads[0]!.reject(new Error("Upload made no progress for 60 seconds."));
  await flush();
  expect(f.uploads).toHaveLength(3);
  expect(f.service.fileUploads.getSnapshot()[f.drafts[0]!.id]).toMatchObject({
    status: "error",
    transport: true,
  });
  f.ready(1);
  f.ready(2);
  await flush();
  expect(f.service.fileUploads.getSnapshot()[third!.id]?.status).toBe("ready");
  expect(f.prompt).not.toHaveBeenCalled();
});

it("keeps new text ahead of concurrent failures restored in submission order", async () => {
  const first = Promise.withResolvers<never>(),
    second = Promise.withResolvers<never>();
  const sink = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const shell = new SessionInputShell({ actx: {} as never, defaultSink: sink });
  cleanup.push(() => {
    shell.dispose();
  });
  shell.actions.setDraft("first");
  shell.submit("queue", "click");
  shell.actions.setDraft("second");
  shell.submit("queue", "click");
  shell.actions.setDraft("new");
  second.reject(new Error("second failed"));
  await vi.waitFor(() => expect(shell.snapshot.draft).toBe("new\n\nsecond"));
  first.reject(new Error("first failed"));
  await vi.waitFor(() => expect(shell.snapshot.draft).toBe("new\n\nfirst\n\nsecond"));
});

it.each(["", "new text"])(
  "restores failed text and all attachments behind current draft %j",
  async (current) => {
    const result = Promise.withResolvers<never>();
    const shell = new SessionInputShell({ actx: {} as never, defaultSink: () => result.promise });
    cleanup.push(() => {
      shell.dispose();
    });
    shell.actions.setDraft("failed text");
    shell.actions.addAttachments(["image", "file"] as never);
    shell.submit("queue", "click");
    await flush();
    expect(shell.snapshot.draft).toBe("");
    shell.actions.setDraft(current);
    result.reject(new Error("retry"));
    await vi.waitFor(() =>
      expect(shell.snapshot.draft).toBe(current ? "new text\n\nfailed text" : "failed text"),
    );
    expect(shell.snapshot.attachmentIds).toEqual(["image", "file"]);
  },
);
