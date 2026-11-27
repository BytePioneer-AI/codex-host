import { describe, expect, it } from "vitest";
import {
  SHELL_WINDOW_HIDDEN_EVENT,
  WINDOW_HIDDEN_ATTRIBUTE,
  installWindowVisibilityGate,
  type WindowVisibilityDocument,
  type WindowVisibilityTarget,
} from "../src/window-visibility.ts";

function createHarness(initial: { documentHidden?: boolean; shellHidden?: boolean } = {}) {
  const attributes = new Map<string, string>();
  const docListeners = new Set<() => void>();
  const winListeners = new Map<string, Set<(event: Event) => void>>();

  let documentHidden = initial.documentHidden ?? false;
  const doc: WindowVisibilityDocument = {
    get hidden() {
      return documentHidden;
    },
    documentElement: {
      setAttribute: (name, value) => {
        attributes.set(name, value);
      },
      removeAttribute: (name) => {
        attributes.delete(name);
      },
    },
    addEventListener: (_type, listener) => {
      docListeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      docListeners.delete(listener);
    },
  };

  const win: WindowVisibilityTarget = {
    ...(initial.shellHidden === undefined ? {} : { __codexhostWindowHidden: initial.shellHidden }),
    addEventListener: (type, listener) => {
      let set = winListeners.get(type);
      if (set === undefined) {
        set = new Set();
        winListeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener: (type, listener) => {
      winListeners.get(type)?.delete(listener);
    },
  };

  return {
    doc,
    win,
    isMarkedHidden: () => attributes.has(WINDOW_HIDDEN_ATTRIBUTE),
    setDocumentHidden: (next: boolean) => {
      documentHidden = next;
      for (const listener of [...docListeners]) listener();
    },
    emitShellHidden: (next: boolean, options?: { omitDetail?: boolean }) => {
      win.__codexhostWindowHidden = next;
      const event = options?.omitDetail
        ? ({ type: SHELL_WINDOW_HIDDEN_EVENT } as Event)
        : ({
            type: SHELL_WINDOW_HIDDEN_EVENT,
            detail: { hidden: next },
          } as unknown as Event);
      for (const listener of [...(winListeners.get(SHELL_WINDOW_HIDDEN_EVENT) ?? [])]) {
        listener(event);
      }
    },
    listenerCounts: () => ({
      document: docListeners.size,
      window: winListeners.get(SHELL_WINDOW_HIDDEN_EVENT)?.size ?? 0,
    }),
  };
}

describe("installWindowVisibilityGate", () => {
  it("toggles the root attribute on document visibilitychange in a standalone browser", () => {
    const harness = createHarness({ documentHidden: false });
    const dispose = installWindowVisibilityGate({ document: harness.doc, window: undefined });

    expect(harness.isMarkedHidden()).toBe(false);

    harness.setDocumentHidden(true);
    expect(harness.isMarkedHidden()).toBe(true);

    harness.setDocumentHidden(false);
    expect(harness.isMarkedHidden()).toBe(false);

    dispose();
  });

  it("synchronizes initial hidden state from either document.hidden or the desktop shell", () => {
    const docHidden = createHarness({ documentHidden: true });
    const disposeDoc = installWindowVisibilityGate({
      document: docHidden.doc,
      window: docHidden.win,
    });
    expect(docHidden.isMarkedHidden()).toBe(true);
    disposeDoc();

    const shellHidden = createHarness({ documentHidden: false, shellHidden: true });
    const disposeShell = installWindowVisibilityGate({
      document: shellHidden.doc,
      window: shellHidden.win,
    });
    expect(shellHidden.isMarkedHidden()).toBe(true);
    disposeShell();
    expect(shellHidden.isMarkedHidden()).toBe(true);
  });

  it("combines document.hidden and desktop shell hidden state with logical OR", () => {
    const harness = createHarness();
    const dispose = installWindowVisibilityGate({ document: harness.doc, window: harness.win });
    expect(harness.isMarkedHidden()).toBe(false);

    // Desktop shell hides first, then browser visibilitychange also reports hidden.
    harness.emitShellHidden(true);
    expect(harness.isMarkedHidden()).toBe(true);
    harness.setDocumentHidden(true);
    expect(harness.isMarkedHidden()).toBe(true);

    // Showing the desktop shell while document.hidden is still true keeps animations paused.
    harness.emitShellHidden(false);
    expect(harness.isMarkedHidden()).toBe(true);

    // Once document.hidden clears as well, animations resume.
    harness.setDocumentHidden(false);
    expect(harness.isMarkedHidden()).toBe(false);

    // Reverse order: document.hidden clears before shell reports visible.
    harness.setDocumentHidden(true);
    harness.emitShellHidden(true);
    harness.setDocumentHidden(false);
    expect(harness.isMarkedHidden()).toBe(true);

    harness.emitShellHidden(false, { omitDetail: true });
    expect(harness.isMarkedHidden()).toBe(false);

    dispose();
  });

  it("detaches listeners and clears the attribute on dispose when shell is visible", () => {
    const harness = createHarness({ documentHidden: true });
    const dispose = installWindowVisibilityGate({ document: harness.doc, window: harness.win });
    expect(harness.isMarkedHidden()).toBe(true);
    expect(harness.listenerCounts()).toEqual({ document: 1, window: 1 });

    dispose();
    expect(harness.listenerCounts()).toEqual({ document: 0, window: 0 });
    expect(harness.isMarkedHidden()).toBe(false);

    harness.setDocumentHidden(true);
    harness.emitShellHidden(true);
    expect(harness.isMarkedHidden()).toBe(false);
  });

  it("tolerates a missing documentElement without throwing", () => {
    const listeners = new Set<() => void>();
    const doc: WindowVisibilityDocument = {
      hidden: true,
      documentElement: null,
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    };
    const dispose = installWindowVisibilityGate({ document: doc, window: undefined });
    for (const listener of listeners) listener();
    dispose();
    expect(listeners.size).toBe(0);
  });
});
