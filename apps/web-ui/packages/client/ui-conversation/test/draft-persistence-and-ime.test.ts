// @vitest-environment jsdom
import type { Context } from "@deepseek-ai/cordis";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAFT_PERSIST_DEBOUNCE_MS, SessionInputShell } from "../src/client/input/facade.ts";
import type { InputTriggerController } from "../src/client/contract/input.ts";

function createShell(options: { track?: ReturnType<typeof vi.fn> } = {}) {
  const track = options.track ?? vi.fn();
  const inputTriggers = {
    track,
    arbitrate: () => "pass" as const,
    onSpace: () => false,
    serializeReference: async (_source: string, ref: string) => ref,
    openReference: () => false,
    adjudicate: async () => undefined,
    lexicon: createSnapshotStore(new Map()),
  } as unknown as InputTriggerController;

  const defaultSink = vi.fn(async () => ({ kind: "success" as const }));
  const shell = new SessionInputShell({
    actx: {} as Context,
    inputTriggers: () => inputTriggers,
    defaultSink,
    commandAttachments: {
      serialize: async () => [],
      release: () => {},
      unsupportedNotice: () => "",
    },
  });
  return { shell, track, defaultSink };
}

describe("SessionInputShell draft persistence debouncing and IME trigger deferral", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("coalesces rapid draft edits and flushes on debounce, unbind, unload, submit, and dispose", async () => {
    vi.useFakeTimers();
    const { shell } = createShell();
    const writer = vi.fn();
    const unbind = shell.bindDraftPersistence(writer);

    // Rapid edits coalesce into a single write after the debounce window.
    shell.setDraft("#a");
    shell.setDraft("#ab");
    shell.setDraft("#abc");
    expect(writer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DRAFT_PERSIST_DEBOUNCE_MS);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenLastCalledWith({ text: "#abc", references: [] });

    // Unbinding (session switch) flushes immediately.
    shell.setDraft("draft before switch");
    expect(writer).toHaveBeenCalledTimes(1);
    unbind();
    expect(writer).toHaveBeenCalledTimes(2);
    expect(writer).toHaveBeenLastCalledWith({ text: "draft before switch", references: [] });

    // Page unload flushes pending edits immediately.
    const writer2 = vi.fn();
    shell.bindDraftPersistence(writer2);
    shell.setDraft("before pagehide");
    expect(writer2).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    expect(writer2).toHaveBeenCalledTimes(1);
    expect(writer2).toHaveBeenLastCalledWith({ text: "before pagehide", references: [] });

    // Submit clears the draft and flushes the empty draft immediately.
    shell.setDraft("send me");
    shell.submit("queue");
    expect(writer2).toHaveBeenLastCalledWith({ text: "", references: [] });

    // Dispose flushes any pending draft write before teardown.
    shell.setDraft("before dispose");
    const callsBeforeDispose = writer2.mock.calls.length;
    shell.dispose();
    expect(writer2).toHaveBeenCalledTimes(callsBeforeDispose + 1);
    expect(writer2).toHaveBeenLastCalledWith({ text: "before dispose", references: [] });
  });

  it("defers input trigger tracking during IME composition and flushes on compositionend", () => {
    const track = vi.fn();
    const { shell } = createShell({ track });
    const root = document.createElement("div");
    root.contentEditable = "true";
    document.body.append(root);
    shell.editor.setRootElement(root);

    try {
      shell.setDraft("#");
      const callsAfterHash = track.mock.calls.length;
      expect(callsAfterHash).toBeGreaterThan(0);

      // During IME composition, intermediate edits do not invoke trigger tracking.
      root.dispatchEvent(new Event("compositionstart"));
      shell.setDraft("#w");
      shell.setDraft("#we");
      shell.setDraft("#wei");
      expect(track).toHaveBeenCalledTimes(callsAfterHash);

      // Ending composition immediately tracks the committed text.
      shell.setDraft("#委派");
      expect(track).toHaveBeenCalledTimes(callsAfterHash);
      root.dispatchEvent(new Event("compositionend"));
      expect(track).toHaveBeenCalledTimes(callsAfterHash + 1);
      expect(track.mock.calls.at(-1)?.[0]).toBe("#委派");
    } finally {
      shell.dispose();
    }
  });
});
