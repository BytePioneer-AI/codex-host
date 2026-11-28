import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { AttachmentId, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type {
  BeginSubmissionInput,
  ISessions,
  SessionBinding,
  SessionFace,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionRequestId } from "@deepseek-ai/dsh-api-session-controller/types";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { ComposerBlocks } from "../src/client/contract/composer-blocks.ts";
import type { SessionInputResolver } from "../src/client/contract/input.ts";
import { HistoricalImageCache } from "../src/client/conversation/historical-images.ts";
import { ConversationController } from "../src/client/service.ts";

function makeRef(
  attachmentId: string,
  overrides: Partial<Omit<ImageAttachmentRef, "attachmentId">> = {},
): ImageAttachmentRef {
  return {
    attachmentId: attachmentId as AttachmentId,
    mediaType: "image/webp",
    bytes: 1024,
    width: 800,
    height: 600,
    ...overrides,
  };
}

function createHarness(options?: { maxEntries?: number; maxBytes?: number }) {
  const disposers: Array<() => void> = [];
  const ctx = {
    effect(fn: () => (() => void) | void) {
      const cleanup = fn();
      if (typeof cleanup === "function") disposers.push(cleanup);
      return () => cleanup?.();
    },
  } as unknown as Context;

  const bindings = new Map<string, SessionBinding>();
  const sessions = {
    binding: (sessionId: SessionId) => bindings.get(sessionId),
  } as unknown as ISessions;

  let nextBlobId = 0;
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  URL.createObjectURL = vi.fn(() => {
    const url = `blob:test-${++nextBlobId}`;
    createdUrls.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revokedUrls.push(url);
  });

  const cache = new HistoricalImageCache(ctx, sessions, options);

  function mountSession(
    sessionId: string,
    readAttachment = vi.fn(async (attachmentId: AttachmentId) => ({
      ok: true as const,
      value: {
        attachment: makeRef(attachmentId, { bytes: 1024 }),
        data: new Uint8Array(1024),
      },
    })),
  ) {
    const binding = {
      sessionId: sessionId as SessionId,
      session: { readAttachment },
    } as unknown as SessionBinding;
    bindings.set(sessionId, binding);
    return { binding, readAttachment };
  }

  function evictSession(sessionId: string) {
    bindings.delete(sessionId);
  }

  function dispose() {
    while (disposers.length > 0) disposers.pop()?.();
  }

  function restoreUrls() {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }

  return {
    cache,
    mountSession,
    evictSession,
    dispose,
    restoreUrls,
    createdUrls,
    revokedUrls,
  };
}

describe("HistoricalImageCache", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("retains loaded images across background session eviction and re-open without re-fetching", async () => {
    const harness = createHarness();
    cleanups.push(() => {
      harness.dispose();
      harness.restoreUrls();
    });

    const first = harness.mountSession("sess-a");
    const ref = makeRef("web-image:aaaa.webp");

    const url1 = await harness.cache.resolve("sess-a" as SessionId, ref);
    expect(url1).toBe("blob:test-1");
    expect(first.readAttachment).toHaveBeenCalledTimes(1);

    // Simulate #1247 background session eviction and later re-open with a new SessionBinding.
    harness.evictSession("sess-a");
    expect(harness.revokedUrls).toEqual([]);

    const reopened = harness.mountSession("sess-a");
    expect(harness.cache.peek("sess-a" as SessionId, ref)).toBe(url1);
    const url2 = await harness.cache.resolve("sess-a" as SessionId, ref);
    expect(url2).toBe(url1);
    expect(reopened.readAttachment).not.toHaveBeenCalled();

    harness.dispose();
    expect(harness.revokedUrls).toEqual([url1]);
  });

  it("enforces maxEntries and maxBytes LRU budgets and revokes evicted blob URLs", async () => {
    const harness = createHarness({ maxEntries: 2, maxBytes: 2500 });
    cleanups.push(() => {
      harness.dispose();
      harness.restoreUrls();
    });

    const session = harness.mountSession(
      "sess-lru",
      vi.fn(async (attachmentId: AttachmentId) => ({
        ok: true as const,
        value: {
          attachment: makeRef(attachmentId, { bytes: 1000 }),
          data: new Uint8Array(1000),
        },
      })),
    );

    const ref1 = makeRef("img-1", { bytes: 1000 });
    const ref2 = makeRef("img-2", { bytes: 1000 });
    const ref3 = makeRef("img-3", { bytes: 1000 });

    const u1 = await harness.cache.resolve("sess-lru" as SessionId, ref1);
    const u2 = await harness.cache.resolve("sess-lru" as SessionId, ref2);
    // Touch img-1 so img-2 becomes the LRU victim.
    expect(harness.cache.peek("sess-lru" as SessionId, ref1)).toBe(u1);

    const u3 = await harness.cache.resolve("sess-lru" as SessionId, ref3);
    expect(harness.revokedUrls).toEqual([u2]);
    expect(harness.cache.peek("sess-lru" as SessionId, ref1)).toBe(u1);
    expect(harness.cache.peek("sess-lru" as SessionId, ref2)).toBeUndefined();
    expect(harness.cache.peek("sess-lru" as SessionId, ref3)).toBe(u3);

    // Inserting a 2000-byte entry exceeds maxBytes (2500) with existing 1000+1000, evicting both older entries.
    const bigSession = harness.mountSession(
      "sess-big",
      vi.fn(async (attachmentId: AttachmentId) => ({
        ok: true as const,
        value: {
          attachment: makeRef(attachmentId, { bytes: 2000 }),
          data: new Uint8Array(2000),
        },
      })),
    );
    const bigRef = makeRef("img-big", { bytes: 2000 });
    const uBig = await harness.cache.resolve("sess-big" as SessionId, bigRef);

    expect(bigSession.readAttachment).toHaveBeenCalledTimes(1);
    expect(harness.revokedUrls).toEqual([u2, u1, u3]);
    expect(harness.cache.peek("sess-big" as SessionId, bigRef)).toBe(uBig);
    expect(session.readAttachment).toHaveBeenCalledTimes(3);
  });

  it("reuses locally uploaded blobs for exact attachmentId and remote peer placeholders without RPC", async () => {
    const harness = createHarness();
    cleanups.push(() => {
      harness.dispose();
      harness.restoreUrls();
    });

    const localSession = harness.mountSession("sess-local");
    const peerSession = harness.mountSession("sess-peer");
    const otherSession = harness.mountSession("sess-other");

    const leaf = `${"a".repeat(64)}.webp`;
    const uploadedId = `web-image:${leaf}`;
    const blob = new Blob([new Uint8Array(2048)], { type: "image/webp" });

    // 1. Local session exact attachmentId hit.
    expect(
      harness.cache.cacheUploaded("sess-local" as SessionId, {
        attachmentId: uploadedId,
        blob,
        name: "screen.webp",
        bytes: 2048,
      }),
    ).toBe(true);

    const localRef = makeRef(uploadedId, { name: "screen.webp", bytes: 2048 });
    const localUrl = harness.cache.peek("sess-local" as SessionId, localRef);
    expect(localUrl).toBe("blob:test-1");
    expect(await harness.cache.resolve("sess-local" as SessionId, localRef)).toBe(localUrl);
    expect(localSession.readAttachment).not.toHaveBeenCalled();

    // Session isolation: another session must not hit sess-local's uploaded entry.
    expect(harness.cache.peek("sess-other" as SessionId, localRef)).toBeUndefined();
    expect(otherSession.readAttachment).not.toHaveBeenCalled();

    // 2. Remote peer placeholder with leaf filename (bytes: 0, peer-image id).
    expect(
      harness.cache.cacheUploaded("sess-peer" as SessionId, {
        attachmentId: uploadedId,
        blob,
        name: "screen.webp",
        bytes: 2048,
      }),
    ).toBe(true);

    const peerLeafRef = makeRef("peer-image:hash-1", {
      name: leaf,
      mediaType: "image/png",
      bytes: 0,
      width: 64,
      height: 64,
    });
    const peerUrl1 = harness.cache.peek("sess-peer" as SessionId, peerLeafRef);
    expect(peerUrl1).toBe("blob:test-2");
    expect(await harness.cache.resolve("sess-peer" as SessionId, peerLeafRef)).toBe(peerUrl1);
    expect(peerSession.readAttachment).not.toHaveBeenCalled();

    // 3. Remote peer placeholder with user filename (bytes: 0) consumes pending-name fallback
    //    so a second upload with the same filename matches the second blob, not the first.
    const blob2 = new Blob([new Uint8Array(1500)], { type: "image/webp" });
    harness.cache.cacheUploaded("sess-peer" as SessionId, {
      attachmentId: `web-image:${"b".repeat(64)}.webp`,
      blob: blob2,
      name: "screen.webp",
      bytes: 1500,
    });
    const peerNameRef = makeRef("peer-image:hash-2", {
      name: "screen.webp",
      mediaType: "image/png",
      bytes: 0,
      width: 64,
      height: 64,
    });
    const peerUrl2 = await harness.cache.resolve("sess-peer" as SessionId, peerNameRef);
    expect(peerUrl2).toBe("blob:test-3");
    // Earlier aliased peer-image:hash-1 still resolves to the first blob.
    expect(harness.cache.peek("sess-peer" as SessionId, peerLeafRef)).toBe(peerUrl1);
    expect(peerSession.readAttachment).not.toHaveBeenCalled();
  });

  it("avoids guessing on ambiguous same-name peer uploads and binds cleanly via aliasUploaded or seed", async () => {
    const harness = createHarness();
    cleanups.push(() => {
      harness.dispose();
      harness.restoreUrls();
    });

    const session = harness.mountSession("sess-ambig");
    const uploadA = `web-image:${"c".repeat(64)}.webp`;
    const uploadB = `web-image:${"d".repeat(64)}.webp`;

    harness.cache.cacheUploaded("sess-ambig" as SessionId, {
      attachmentId: uploadA,
      blob: new Blob([new Uint8Array(500)], { type: "image/webp" }),
      name: "image.webp",
      bytes: 500,
    });
    harness.cache.cacheUploaded("sess-ambig" as SessionId, {
      attachmentId: uploadB,
      blob: new Blob([new Uint8Array(600)], { type: "image/webp" }),
      name: "image.webp",
      bytes: 600,
    });

    const peerRefA = makeRef("peer-image:a", { name: "image.webp", bytes: 0 });
    const peerRefB = makeRef("peer-image:b", { name: "image.webp", bytes: 0 });

    // Two unconsumed uploads share "image.webp": name-only fallback stays silent instead of guessing.
    expect(harness.cache.peek("sess-ambig" as SessionId, peerRefA)).toBeUndefined();

    // Positional aliasUploaded binds each peer ref to its exact uploaded Blob URL.
    expect(harness.cache.aliasUploaded("sess-ambig" as SessionId, uploadA, peerRefA)).toBe(true);
    expect(harness.cache.aliasUploaded("sess-ambig" as SessionId, uploadB, peerRefB)).toBe(true);
    expect(await harness.cache.resolve("sess-ambig" as SessionId, peerRefA)).toBe("blob:test-1");
    expect(await harness.cache.resolve("sess-ambig" as SessionId, peerRefB)).toBe("blob:test-2");

    // seed() adopts a local preview URL directly without calling readAttachment.
    const seededRef = makeRef("peer-image:seeded", { bytes: 400 });
    expect(harness.cache.seed("sess-ambig" as SessionId, seededRef, "blob:preview-99", 400)).toBe(
      true,
    );
    expect(await harness.cache.resolve("sess-ambig" as SessionId, seededRef)).toBe(
      "blob:preview-99",
    );
    expect(session.readAttachment).not.toHaveBeenCalled();

    // Discarding a pending draft clears its pending-name entry so a later upload is unambiguous.
    const uploadDiscarded = `web-image:${"e".repeat(64)}.webp`;
    const uploadKept = `web-image:${"f".repeat(64)}.webp`;
    harness.cache.cacheUploaded("sess-ambig" as SessionId, {
      attachmentId: uploadDiscarded,
      blob: new Blob([new Uint8Array(500)], { type: "image/webp" }),
      name: "retry.webp",
      bytes: 500,
    });
    harness.cache.clearPendingUploaded("sess-ambig" as SessionId, uploadDiscarded);
    harness.cache.cacheUploaded("sess-ambig" as SessionId, {
      attachmentId: uploadKept,
      blob: new Blob([new Uint8Array(700)], { type: "image/webp" }),
      name: "retry.webp",
      bytes: 700,
    });
    const retryRef = makeRef("peer-image:retry", { name: "retry.webp", bytes: 0 });
    expect(harness.cache.peek("sess-ambig" as SessionId, retryRef)).toBe("blob:test-4");
  });

  it("aliases remote peer uploaded image on observation before retirement frame so first durable render never re-downloads", async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    let nextBlobId = 0;
    const createdUrls: string[] = [];
    const revokedUrls: string[] = [];
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:peer-test-${++nextBlobId}`;
      createdUrls.push(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
      revokedUrls.push(url);
    });

    const ctx = new Context();
    const sessionId = "sess-remote-peer" as SessionId;
    const uploadedAttachmentId = `web-image:${"a".repeat(64)}.webp` as AttachmentId;
    const peerRef: ImageAttachmentRef = {
      attachmentId: `peer-image:${"b".repeat(64)}` as AttachmentId,
      name: "image-1.webp",
      mediaType: "image/png",
      bytes: 0,
      width: 64,
      height: 64,
    };

    const readAttachment = vi.fn(async () => ({
      ok: true as const,
      value: { attachment: peerRef, data: new Uint8Array(1024) },
    }));
    const bindings = new Map<SessionId, SessionBinding>();
    const sessions = {
      binding: (id: SessionId) => bindings.get(id),
      retain: () => ({ release: vi.fn() }),
    } as unknown as ISessions;
    const cache = new HistoricalImageCache(ctx, sessions);
    const seedImageUrl = vi.fn(
      (id: SessionId, attachment: ImageAttachmentRef, url: string, bytes?: number) =>
        cache.seed(id, attachment, url, bytes),
    );
    const aliasUploadedImage = vi.fn(
      (id: SessionId, uploadedId: string, target: ImageAttachmentRef) =>
        cache.aliasUploaded(id, uploadedId, target),
    );
    const uiConversation = {
      cacheUploadedImage: (
        id: SessionId,
        uploaded: Parameters<HistoricalImageCache["cacheUploaded"]>[1],
      ) => cache.cacheUploaded(id, uploaded),
      aliasUploadedImage,
      clearPendingUploadedImage: (id: SessionId, uploadedId: string) => {
        cache.clearPendingUploaded(id, uploadedId);
      },
      seedImageUrl,
    };
    const upload = vi.fn(async () => ({
      ok: true as const,
      value: {
        receiptId: "receipt-peer-1",
        file: {
          attachmentId: uploadedAttachmentId,
          name: "large-2600x1600.webp",
          bytes: 1_500_000,
        },
      },
    }));

    ctx.provide("sessions", sessions);
    ctx.provide("uiConversation", uiConversation as never);
    ctx.provide("fileUpload", { upload } as never);
    ctx.provide("locale", { bind: () => (key: string) => key } as never);

    const controller = new ConversationController(ctx, {
      input: {} as SessionInputResolver,
      blocks: {} as ComposerBlocks,
      maxConcurrentFileUploads: 2,
    });

    let capturedObserved: BeginSubmissionInput["onObserved"];
    let capturedRetire: BeginSubmissionInput["onRetire"];
    const scheduledFrames: Array<() => void> = [];

    const session = {
      sessionId,
      getSnapshot: () => ({ subagent: null }),
      beginSubmission: (input: BeginSubmissionInput) => {
        capturedObserved = input.onObserved;
        capturedRetire = input.onRetire;
        return {
          requestId: "req-peer-1" as SessionRequestId,
          abandon: vi.fn(),
        };
      },
      prompt: vi.fn(async () => ({ ok: true as const, value: { accepted: true } })),
      readAttachment,
    } as unknown as SessionFace;

    bindings.set(sessionId, { sessionId, session } as unknown as SessionBinding);

    cleanups.push(() => {
      void ctx.fiber.dispose();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    });

    const imageFile = new File([new Uint8Array(2048)], "large-2600x1600.webp", {
      type: "image/webp",
    });
    const [draft] = controller.createDrafts(sessionId, [imageFile]);
    expect(draft?.kind).toBe("image");
    if (draft === undefined || draft.kind !== "image") throw new Error("expected image draft");

    await vi.waitFor(() => {
      expect(controller.fileUploads.getSnapshot()[draft.id]?.status).toBe("ready");
    });
    // blob:peer-test-1 is the draft previewUrl; blob:peer-test-2 is HistoricalImageCache's uploaded blob URL.
    expect(createdUrls).toEqual(["blob:peer-test-1", "blob:peer-test-2"]);

    const sendPromise = controller.sendSession(session, "inspect image", [draft.id], "queue");
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledTimes(1);
    });

    // Durable user/message arrives with renamed remote peer placeholder:
    // onObserved runs synchronously, while onRetire is deferred to the next animation frame.
    capturedObserved?.([peerRef]);
    scheduledFrames.push(() => {
      capturedRetire?.({ reason: "observed", attachments: [peerRef] });
    });

    // BEFORE the retirement frame runs, the durable node's first render must hit the cached
    // blob URL directly with 0 readAttachment RPCs, and the echo's previewUrl must stay live.
    expect(cache.peek(sessionId, peerRef)).toBe("blob:peer-test-2");
    expect(await cache.resolve(sessionId, peerRef)).toBe("blob:peer-test-2");
    expect(readAttachment).not.toHaveBeenCalled();
    expect(revokedUrls).toEqual([]);
    expect(controller.resolveDraftAttachments([draft.id])).toHaveLength(1);

    // Triggering the retirement frame cleans up draft state and revokes only the echo previewUrl,
    // without creating a new ObjectURL or calling seedImageUrl.
    for (const frame of scheduledFrames) frame();
    await expect(sendPromise).resolves.toEqual({ kind: "success" });

    expect(controller.resolveDraftAttachments([draft.id])).toEqual([]);
    expect(controller.fileUploads.getSnapshot()).toEqual({});
    expect(revokedUrls).toEqual(["blob:peer-test-1"]);
    expect(createdUrls).toEqual(["blob:peer-test-1", "blob:peer-test-2"]);
    expect(seedImageUrl).not.toHaveBeenCalled();
    expect(cache.peek(sessionId, peerRef)).toBe("blob:peer-test-2");
    expect(readAttachment).not.toHaveBeenCalled();
  });

  it("keeps previewUrl intact until onRetire when pre-cached uploaded entry is absent", async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    let nextBlobId = 0;
    const revokedUrls: string[] = [];
    URL.createObjectURL = vi.fn(() => `blob:fallback-test-${++nextBlobId}`);
    URL.revokeObjectURL = vi.fn((url: string) => {
      revokedUrls.push(url);
    });

    const ctx = new Context();
    const sessionId = "sess-remote-fallback" as SessionId;
    const uploadedAttachmentId = `web-image:${"c".repeat(64)}.webp` as AttachmentId;
    const peerRef: ImageAttachmentRef = {
      attachmentId: `peer-image:${"d".repeat(64)}` as AttachmentId,
      name: "image-1.webp",
      mediaType: "image/png",
      bytes: 0,
      width: 64,
      height: 64,
    };

    const bindings = new Map<SessionId, SessionBinding>();
    const sessions = {
      binding: (id: SessionId) => bindings.get(id),
      retain: () => ({ release: vi.fn() }),
    } as unknown as ISessions;
    const cache = new HistoricalImageCache(ctx, sessions);
    const seedImageUrl = vi.fn(
      (id: SessionId, attachment: ImageAttachmentRef, url: string, bytes?: number) =>
        cache.seed(id, attachment, url, bytes),
    );
    const uiConversation = {
      // Simulate pre-caching unavailable / evicted before observation.
      cacheUploadedImage: vi.fn(() => false),
      aliasUploadedImage: (id: SessionId, uploadedId: string, target: ImageAttachmentRef) =>
        cache.aliasUploaded(id, uploadedId, target),
      clearPendingUploadedImage: (id: SessionId, uploadedId: string) => {
        cache.clearPendingUploaded(id, uploadedId);
      },
      seedImageUrl,
    };
    const upload = vi.fn(async () => ({
      ok: true as const,
      value: {
        receiptId: "receipt-peer-2",
        file: {
          attachmentId: uploadedAttachmentId,
          name: "large-2600x1600.webp",
          bytes: 1_500_000,
        },
      },
    }));

    ctx.provide("sessions", sessions);
    ctx.provide("uiConversation", uiConversation as never);
    ctx.provide("fileUpload", { upload } as never);
    ctx.provide("locale", { bind: () => (key: string) => key } as never);

    const controller = new ConversationController(ctx, {
      input: {} as SessionInputResolver,
      blocks: {} as ComposerBlocks,
      maxConcurrentFileUploads: 2,
    });

    let capturedObserved: BeginSubmissionInput["onObserved"];
    let capturedRetire: BeginSubmissionInput["onRetire"];

    const session = {
      sessionId,
      getSnapshot: () => ({ subagent: null }),
      beginSubmission: (input: BeginSubmissionInput) => {
        capturedObserved = input.onObserved;
        capturedRetire = input.onRetire;
        return {
          requestId: "req-peer-2" as SessionRequestId,
          abandon: vi.fn(),
        };
      },
      prompt: vi.fn(async () => ({ ok: true as const, value: { accepted: true } })),
      readAttachment: vi.fn(),
    } as unknown as SessionFace;

    bindings.set(sessionId, { sessionId, session } as unknown as SessionBinding);

    cleanups.push(() => {
      void ctx.fiber.dispose();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    });

    const imageFile = new File([new Uint8Array(2048)], "large-2600x1600.webp", {
      type: "image/webp",
    });
    const [draft] = controller.createDrafts(sessionId, [imageFile]);
    if (draft === undefined || draft.kind !== "image") throw new Error("expected image draft");

    await vi.waitFor(() => {
      expect(controller.fileUploads.getSnapshot()[draft.id]?.status).toBe("ready");
    });

    const sendPromise = controller.sendSession(session, "fallback image", [draft.id], "queue");
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledTimes(1);
    });

    // During observation without a pre-cached entry, previewUrl is neither seeded nor revoked.
    capturedObserved?.([peerRef]);
    expect(seedImageUrl).not.toHaveBeenCalled();
    expect(revokedUrls).toEqual([]);

    // On retirement frame, seedImageUrl safely adopts previewUrl without revoking it.
    capturedRetire?.({ reason: "observed", attachments: [peerRef] });
    await expect(sendPromise).resolves.toEqual({ kind: "success" });
    expect(seedImageUrl).toHaveBeenCalledTimes(1);
    expect(revokedUrls).toEqual([]);
    expect(cache.peek(sessionId, peerRef)).toBe("blob:fallback-test-1");
  });
});
