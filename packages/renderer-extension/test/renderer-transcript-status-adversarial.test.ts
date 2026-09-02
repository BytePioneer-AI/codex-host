import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ENGLISH_STATUS_MESSAGES,
  TRANSCRIPT_STATUS_CHIP_ATTRIBUTE,
  TRANSCRIPT_STATUS_STATE_ATTRIBUTE,
  mountRendererTranscriptStatusChip,
  transcriptStatusMessages,
  type AdapterStatusState,
} from "../src/renderer-transcript-status-chip.js";
import {
  TRANSCRIPT_STATUS_CONTAINER_ATTRIBUTE,
  findTranscriptTarget,
  installRendererTranscriptStatusInjector,
} from "../src/renderer-transcript-status-injector.js";
import {
  resolveRendererSettingsLocale,
  type RendererSettingsLocale,
} from "../src/settings/localization.js";

interface MockListener {
  type: string;
  callback: (event: unknown) => void;
}

class FakeDOMElement {
  public tagName: string;
  public attributes = new Map<string, string>();
  public style: Record<string, string> = {};
  public children: FakeDOMElement[] = [];
  public parentElement: FakeDOMElement | null = null;
  public className = "";
  public hidden = false;
  public ownerDocument: FakeDOMDocument;
  public listeners: MockListener[] = [];
  public dataset: Record<string, string> = {};
  private _textContent = "";

  constructor(tagName: string, ownerDocument: FakeDOMDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get textContent(): string {
    if (this.children.length === 0) return this._textContent;
    return this.children.map((c) => c.textContent).join("");
  }

  set textContent(value: string) {
    this._textContent = value;
    this.children = [];
  }

  get isConnected(): boolean {
    if (this === this.ownerDocument.body || this === this.ownerDocument.documentElement) {
      return true;
    }
    let parent: FakeDOMElement | null = this.parentElement;
    while (parent) {
      if (parent === this.ownerDocument.body || parent === this.ownerDocument.documentElement) {
        return true;
      }
      parent = parent.parentElement;
    }
    return false;
  }

  getAttribute(name: string): string | null {
    if (name === "class") return this.className;
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    if (name === "class") {
      this.className = value;
    }
    this.attributes.set(name, value);
    if (name.startsWith("data-")) {
      const prop = name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      this.dataset[prop] = value;
    }
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name.startsWith("data-")) {
      const prop = name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      Reflect.deleteProperty(this.dataset, prop);
    }
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  append(...nodes: (FakeDOMElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        const textNode = this.ownerDocument.createElement("span");
        textNode.textContent = node;
        this.append(textNode);
      } else {
        node.parentElement = this;
        this.children.push(node);
      }
    }
  }

  remove(): void {
    if (this.parentElement) {
      const index = this.parentElement.children.indexOf(this);
      if (index !== -1) {
        this.parentElement.children.splice(index, 1);
      }
      this.parentElement = null;
    }
  }

  replaceChildren(...nodes: (FakeDOMElement | string)[]): void {
    for (const child of this.children) {
      child.parentElement = null;
    }
    this.children = [];
    this.append(...nodes);
  }

  querySelector<T extends FakeDOMElement = FakeDOMElement>(selector: string): T | null {
    const all = this.querySelectorAll<T>(selector);
    return all[0] ?? null;
  }

  querySelectorAll<T extends FakeDOMElement = FakeDOMElement>(selector: string): T[] {
    const results: T[] = [];
    const check = (node: FakeDOMElement): void => {
      if (node.matches(selector)) {
        results.push(node as unknown as T);
      }
      for (const child of node.children) {
        check(child);
      }
    };
    for (const child of this.children) {
      check(child);
    }
    return results;
  }

  matches(selector: string): boolean {
    if (selector.includes(",")) {
      const parts = selector.split(",").map((s) => s.trim());
      return parts.some((part) => this.matches(part));
    }
    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      return this.className.split(/\s+/).includes(className);
    }
    if (selector.startsWith("[") && selector.endsWith("]")) {
      const raw = selector.slice(1, -1);
      if (raw.includes("=")) {
        const [attr, val] = raw.split("=");
        const cleanVal = val?.replace(/['"]/g, "");
        if (attr) {
          return this.getAttribute(attr) === cleanVal;
        }
        return false;
      }
      return this.hasAttribute(raw);
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  addEventListener(type: string, callback: (event: unknown) => void): void {
    this.listeners.push({ type, callback });
  }

  removeEventListener(type: string, callback: (event: unknown) => void): void {
    this.listeners = this.listeners.filter((l) => l.type !== type || l.callback !== callback);
  }

  dispatchEvent(event: unknown): boolean {
    const type = (event as { type: string }).type;
    for (const l of this.listeners) {
      if (l.type === type) {
        l.callback(event);
      }
    }
    return true;
  }
}

class FakeMutationObserver {
  public static instances: FakeMutationObserver[] = [];
  public callback: (mutations: unknown[], observer: FakeMutationObserver) => void;
  public target: FakeDOMElement | null = null;
  public options: unknown = null;
  public disconnected = false;

  constructor(callback: (mutations: unknown[], observer: FakeMutationObserver) => void) {
    this.callback = callback;
    FakeMutationObserver.instances.push(this);
  }

  observe(target: FakeDOMElement, options?: unknown): void {
    this.target = target;
    this.options = options;
    this.disconnected = false;
  }

  disconnect(): void {
    this.disconnected = true;
    this.target = null;
  }

  trigger(): void {
    if (!this.disconnected) {
      this.callback([], this);
    }
  }
}

class FakeDOMDocument {
  public head: FakeDOMElement;
  public body: FakeDOMElement;
  public documentElement: FakeDOMElement;
  public defaultView: {
    MutationObserver: typeof FakeMutationObserver;
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
    addEventListener: (type: string, cb: (e: unknown) => void) => void;
    removeEventListener: (type: string, cb: (e: unknown) => void) => void;
    dispatchEvent: (event: unknown) => void;
    listenerCount: () => number;
  };
  private globalListeners: MockListener[] = [];

  constructor() {
    this.documentElement = new FakeDOMElement("html", this);
    this.head = new FakeDOMElement("head", this);
    this.body = new FakeDOMElement("body", this);
    this.documentElement.append(this.head, this.body);

    this.defaultView = {
      MutationObserver: FakeMutationObserver,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      addEventListener: (type: string, callback: (e: unknown) => void) => {
        this.globalListeners.push({ type, callback });
      },
      removeEventListener: (type: string, callback: (e: unknown) => void) => {
        this.globalListeners = this.globalListeners.filter(
          (l) => l.type !== type || l.callback !== callback,
        );
      },
      dispatchEvent: (event: unknown) => {
        const type = (event as { type: string }).type;
        for (const l of [...this.globalListeners]) {
          if (l.type === type) {
            l.callback(event);
          }
        }
      },
      listenerCount: () => this.globalListeners.length,
    };
  }

  createElement(tagName: string): FakeDOMElement {
    return new FakeDOMElement(tagName, this);
  }

  querySelector<T extends FakeDOMElement = FakeDOMElement>(selector: string): T | null {
    return this.documentElement.querySelector<T>(selector);
  }

  querySelectorAll<T extends FakeDOMElement = FakeDOMElement>(selector: string): T[] {
    return this.documentElement.querySelectorAll<T>(selector);
  }
}

describe("Adversarial Stress Verification: Renderer Transcript Status Indicator", () => {
  let doc: FakeDOMDocument;
  const originalGlobalElement = (globalThis as Record<string, unknown>)["Element"];

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as Record<string, unknown>)["Element"] = FakeDOMElement;
    (globalThis as Record<string, unknown>)["HTMLElement"] = FakeDOMElement;
    FakeMutationObserver.instances = [];
    doc = new FakeDOMDocument();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalGlobalElement === undefined) {
      delete (globalThis as Record<string, unknown>)["Element"];
    } else {
      (globalThis as Record<string, unknown>)["Element"] = originalGlobalElement;
    }
  });

  describe("1. Timer Auto-Removal & Race Condition Stress Tests", () => {
    it("handles rapid status flipping (running -> completed -> running -> completed) without premature removal", () => {
      const chip = mountRendererTranscriptStatusChip({
        status: "running",
        locale: "en",
        ownerDocument: doc as unknown as Document,
      });

      doc.body.append(chip.element as unknown as FakeDOMElement);
      expect(chip.element.isConnected).toBe(true);
      expect(chip.element.getAttribute(TRANSCRIPT_STATUS_STATE_ATTRIBUTE)).toBe("running");

      // Flip to completed (Timer 1 scheduled for t = 0 + 3000ms = 3000ms)
      chip.setStatus("completed");
      expect(chip.element.getAttribute(TRANSCRIPT_STATUS_STATE_ATTRIBUTE)).toBe("completed");

      // Advance 1500ms (t = 1500ms)
      vi.advanceTimersByTime(1500);
      expect(chip.element.isConnected).toBe(true);

      // Flip back to running (Timer 1 must be cancelled!)
      chip.setStatus("running");
      expect(chip.element.getAttribute(TRANSCRIPT_STATUS_STATE_ATTRIBUTE)).toBe("running");
      expect(chip.element.textContent).toContain("Running...");

      // Advance another 1000ms (t = 2500ms)
      vi.advanceTimersByTime(1000);
      expect(chip.element.isConnected).toBe(true);

      // Flip to completed again (Timer 2 scheduled for t = 2500 + 3000ms = 5500ms)
      chip.setStatus("completed");
      expect(chip.element.getAttribute(TRANSCRIPT_STATUS_STATE_ATTRIBUTE)).toBe("completed");

      // Advance 1000ms (t = 3500ms).
      // Critical check: If Timer 1 was NOT cancelled, it would have fired at t = 3000ms and removed the chip here!
      vi.advanceTimersByTime(1000);
      expect(chip.element.isConnected).toBe(true);
      expect(chip.element.textContent).toContain("Completed");

      // Advance 1999ms (t = 5499ms). Still connected just before 3000ms from 2nd completion.
      vi.advanceTimersByTime(1999);
      expect(chip.element.isConnected).toBe(true);

      // Advance 1ms (t = 5500ms). Exact 3000ms elapsed since 2nd completion -> chip removed.
      vi.advanceTimersByTime(1);
      expect(chip.element.isConnected).toBe(false);

      chip.dispose();
    });

    it("clears pending auto-removal timer on dispose() without throwing or firing on unmounted DOM", () => {
      const onDismiss = vi.fn();
      const chip = mountRendererTranscriptStatusChip({
        status: "completed",
        ownerDocument: doc as unknown as Document,
        onDismiss,
      });

      doc.body.append(chip.element as unknown as FakeDOMElement);
      expect(chip.element.isConnected).toBe(true);

      // Dispose while auto-dismiss timer is pending
      expect(() => chip.dispose()).not.toThrow();
      expect(chip.element.isConnected).toBe(false);

      // Advance time by 10 seconds — timer callback must NOT throw and onDismiss must NOT be called
      expect(() => vi.advanceTimersByTime(10000)).not.toThrow();
      expect(onDismiss).not.toHaveBeenCalled();

      // Ensure calling setStatus on disposed chip is a safe no-op
      expect(() => chip.setStatus("running")).not.toThrow();
      expect(chip.element.isConnected).toBe(false);
    });

    it("survives a rapid flood of 100 status transitions while maintaining single container and correct state", () => {
      const transcriptRoot = doc.createElement("div");
      transcriptRoot.setAttribute("data-testid", "conversation-turns");
      doc.body.append(transcriptRoot);

      const injector = installRendererTranscriptStatusInjector({
        root: transcriptRoot as unknown as ParentNode,
        ownerDocument: doc as unknown as Document,
      });

      const possibleStates: AdapterStatusState[] = [
        "ready",
        "running",
        "completed",
        "failed",
        "interrupted",
      ];

      // Dispatch 100 rapid status updates in a synchronous loop
      for (let i = 0; i < 100; i++) {
        const state = possibleStates[i % possibleStates.length] ?? "ready";
        injector.setStatus(state);
      }

      // Final state is 99 % 5 = 4 ("interrupted")
      expect(injector.getStatus()).toBe("interrupted");

      // Verify exactly ONE status container exists in the DOM
      const containers = transcriptRoot.querySelectorAll(
        `[${TRANSCRIPT_STATUS_CONTAINER_ATTRIBUTE}]`,
      );
      expect(containers.length).toBe(1);

      // Verify the container contains the current chip with "Interrupted"
      const currentContainer = containers[0];
      expect(currentContainer).toBeDefined();
      if (!currentContainer) throw new Error("Expected container to exist");
      const chips = currentContainer.querySelectorAll(`[${TRANSCRIPT_STATUS_CHIP_ATTRIBUTE}]`);
      expect(chips.length).toBe(1);
      expect(currentContainer.textContent).toContain("Interrupted");
      expect(chips[0]?.getAttribute(TRANSCRIPT_STATUS_STATE_ATTRIBUTE)).toBe("interrupted");

      injector.dispose();
      expect(
        transcriptRoot.querySelectorAll(`[${TRANSCRIPT_STATUS_CONTAINER_ATTRIBUTE}]`).length,
      ).toBe(0);
    });

    it("handles 100 rapid window custom events across alternating event names", () => {
      const transcriptRoot = doc.createElement("div");
      transcriptRoot.setAttribute("data-testid", "conversation-turns");
      doc.body.append(transcriptRoot);

      const injector = installRendererTranscriptStatusInjector({
        root: transcriptRoot as unknown as ParentNode,
        ownerDocument: doc as unknown as Document,
      });

      for (let i = 0; i < 100; i++) {
        const eventName =
          i % 2 === 0 ? "codexhost:transcript-status" : "codexhost:transcript-status-changed";
        const status: AdapterStatusState = i % 2 === 0 ? "running" : "failed";
        const locale = i % 4 === 0 ? "zh-CN" : "en";

        doc.defaultView.dispatchEvent({
          type: eventName,
          detail: { status, locale },
        });
      }

      // Event 99: status = "failed", locale = "en"
      expect(injector.getStatus()).toBe("failed");
      expect(injector.chip.locale).toBe("en");
      expect(transcriptRoot.textContent).toContain("Failed");

      injector.dispose();
    });

    it("handles complex interleaved transitions with timer increments (50 cycles)", () => {
      const chip = mountRendererTranscriptStatusChip({
        status: "ready",
        locale: "en",
        ownerDocument: doc as unknown as Document,
      });
      doc.body.append(chip.element as unknown as FakeDOMElement);

      const transitions: {
        status: AdapterStatusState;
        advanceMs: number;
        expectedConnected: boolean;
      }[] = [
        { status: "running", advanceMs: 1000, expectedConnected: true },
        { status: "completed", advanceMs: 1000, expectedConnected: true },
        { status: "running", advanceMs: 2500, expectedConnected: true },
        { status: "completed", advanceMs: 3500, expectedConnected: false }, // Should auto-remove
        { status: "ready", advanceMs: 500, expectedConnected: false }, // Ready doesn't auto-attach without injector
        { status: "failed", advanceMs: 1000, expectedConnected: false },
      ];

      for (const t of transitions) {
        chip.setStatus(t.status);
        vi.advanceTimersByTime(t.advanceMs);
        expect(chip.element.isConnected).toBe(t.expectedConnected);
      }

      chip.dispose();
    });
  });

  describe("2. Localization & Fallback Stress Tests", () => {
    it("falls back cleanly to English for invalid, null, undefined, or unsupported locales", () => {
      const unsupportedLocales = [
        "fr",
        "de",
        "ja",
        "es",
        "ru",
        "ko",
        "",
        "unknown-LOCALE",
        null,
        undefined,
        "123",
        "{}",
      ];

      for (const locale of unsupportedLocales) {
        const messages = transcriptStatusMessages(locale as unknown as RendererSettingsLocale);
        expect(messages).toBe(ENGLISH_STATUS_MESSAGES);
        expect(messages.ready).toBe("Ready");
        expect(messages.running).toBe("Running...");
        expect(messages.completed).toBe("Completed");
        expect(messages.failed).toBe("Failed");
        expect(messages.interrupted).toBe("Interrupted");
      }
    });

    it("tests resolveRendererSettingsLocale resilience against malformed tags and unsupported languages", () => {
      expect(resolveRendererSettingsLocale([])).toBe("en");
      expect(resolveRendererSettingsLocale(["fr-FR", "de-DE", "ja-JP"])).toBe("en");
      expect(resolveRendererSettingsLocale(["!@#$%^&*()", "invalid.tag"])).toBe("en");
      expect(resolveRendererSettingsLocale(["zh-Hans-CN"])).toBe("zh-CN");
      expect(resolveRendererSettingsLocale(["zh-Hant-TW"])).toBe("zh-CN");
      expect(resolveRendererSettingsLocale(["zh"])).toBe("zh-CN");
      expect(resolveRendererSettingsLocale(["en-US", "zh-CN"])).toBe("en");
      expect(resolveRendererSettingsLocale(["fr-FR", "zh-CN"])).toBe("zh-CN");
    });

    it("dynamically changes locale at runtime on chip and handles invalid locale switch", () => {
      const chip = mountRendererTranscriptStatusChip({
        status: "interrupted",
        locale: "zh-CN",
        ownerDocument: doc as unknown as Document,
      });

      expect(chip.element.textContent).toContain("已中断");

      // Switch to unsupported locale -> falls back to English cleanly
      chip.setLocale("de" as unknown as RendererSettingsLocale);
      expect(chip.element.textContent).toContain("Interrupted");

      // Switch back to zh-CN
      chip.setLocale("zh-CN");
      expect(chip.element.textContent).toContain("已中断");

      chip.dispose();
    });
  });

  describe("3. DOM Resilience, Reconnection & Memory Safety", () => {
    it("safely resolves target when DOM has no turns or matches fallback elements", () => {
      const emptyRoot = doc.createElement("div");
      // Target should fall back to emptyRoot itself when HTMLElement-like
      const target = findTranscriptTarget(emptyRoot as unknown as ParentNode);
      expect(target).toBe(emptyRoot);

      // Root without matching turns
      const rootWithMain = doc.createElement("div");
      const main = doc.createElement("main");
      rootWithMain.append(main);
      expect(findTranscriptTarget(rootWithMain as unknown as ParentNode)).toBe(main);
    });

    it("reconnects status container to newly added transcript turns via MutationObserver", () => {
      const transcriptRoot = doc.createElement("div");
      transcriptRoot.setAttribute("data-testid", "conversation-turns");
      doc.body.append(transcriptRoot);

      const turn1 = doc.createElement("div");
      turn1.setAttribute("data-turn-key", "turn-1");
      transcriptRoot.append(turn1);

      const injector = installRendererTranscriptStatusInjector({
        root: transcriptRoot as unknown as ParentNode,
        ownerDocument: doc as unknown as Document,
      });

      // Initial placement should be inside turn1
      expect(injector.container.parentElement).toBe(turn1);

      // Simulate new turn added to transcript
      const turn2 = doc.createElement("div");
      turn2.setAttribute("data-turn-key", "turn-2");
      transcriptRoot.append(turn2);

      // Trigger mutation observer
      const observer = FakeMutationObserver.instances[0];
      expect(observer).toBeDefined();
      observer?.trigger();

      // Injector should now have migrated container to latest turn (turn2)
      expect(injector.container.parentElement).toBe(turn2);

      injector.dispose();
    });

    it("does not pollute current turn status with error elements from historical turns", () => {
      const transcriptRoot = doc.createElement("div");
      transcriptRoot.setAttribute("data-testid", "conversation-turns");
      doc.body.append(transcriptRoot);

      // Turn 1 had an error in the past
      const turn1 = doc.createElement("div");
      turn1.setAttribute("data-turn-key", "turn-1");
      const turn1Error = doc.createElement("div");
      turn1Error.setAttribute("data-testid", "turn-error");
      turn1Error.textContent = "Failed in turn 1";
      turn1.append(turn1Error);
      transcriptRoot.append(turn1);

      // Turn 2 is created and starts running
      const turn2 = doc.createElement("div");
      turn2.setAttribute("data-turn-key", "turn-2");
      transcriptRoot.append(turn2);

      const stopBtn = doc.createElement("button");
      stopBtn.setAttribute("data-testid", "composer-stop-button");
      doc.body.append(stopBtn);

      const injector = installRendererTranscriptStatusInjector({
        root: doc.body as unknown as ParentNode,
        ownerDocument: doc as unknown as Document,
      });

      const observer = FakeMutationObserver.instances[0];
      observer?.trigger();
      expect(injector.getStatus()).toBe("running");

      // Turn 2 completes successfully without errors in turn 2
      stopBtn.remove();
      observer?.trigger();

      // Must be "completed", NOT "failed", despite turn 1 having turn-error
      expect(injector.getStatus()).toBe("completed");

      injector.dispose();
    });

    it("re-attaches dismissed completed chip to container when new status arrives", () => {
      const transcriptRoot = doc.createElement("div");
      transcriptRoot.setAttribute("data-testid", "conversation-turns");
      doc.body.append(transcriptRoot);

      const injector = installRendererTranscriptStatusInjector({
        root: transcriptRoot as unknown as ParentNode,
        ownerDocument: doc as unknown as Document,
      });

      injector.setStatus("completed");
      expect(
        injector.container.querySelector(`[${TRANSCRIPT_STATUS_CHIP_ATTRIBUTE}]`),
      ).not.toBeNull();

      // Advance 3000ms to trigger auto-dismissal
      vi.advanceTimersByTime(3000);
      expect(injector.container.querySelector(`[${TRANSCRIPT_STATUS_CHIP_ATTRIBUTE}]`)).toBeNull();

      // New turn starts: status set to running
      injector.setStatus("running");

      // Chip must be re-attached into container
      const reattachedChip = injector.container.querySelector(
        `[${TRANSCRIPT_STATUS_CHIP_ATTRIBUTE}]`,
      );
      expect(reattachedChip).not.toBeNull();
      expect(reattachedChip?.textContent).toContain("Running...");

      injector.dispose();
    });

    it("guarantees idempotent disposal without throwing or double cleanup side-effects", () => {
      const transcriptRoot = doc.createElement("div");
      doc.body.append(transcriptRoot);

      const initialListeners = doc.defaultView.listenerCount();

      const injector = installRendererTranscriptStatusInjector({
        root: transcriptRoot as unknown as ParentNode,
        ownerDocument: doc as unknown as Document,
      });

      // Added 3 event listeners (renderer-adapter-status, transcript-status, transcript-status-changed)
      expect(doc.defaultView.listenerCount()).toBe(initialListeners + 3);

      // Call dispose multiple times consecutively
      expect(() => {
        injector.dispose();
        injector.dispose();
        injector.dispose();
        injector.dispose();
        injector.dispose();
      }).not.toThrow();

      // Listeners should be cleanly removed back to initial count
      expect(doc.defaultView.listenerCount()).toBe(initialListeners);

      // Mutation observer should be disconnected
      const observer = FakeMutationObserver.instances[0];
      expect(observer?.disconnected).toBe(true);

      // Container should be removed from DOM
      expect(injector.container.parentElement).toBeNull();
    });

    it("handles zero-delay autoDismissDelayMs without scheduling timers", () => {
      const onDismiss = vi.fn();
      const chip = mountRendererTranscriptStatusChip({
        status: "completed",
        autoDismissDelayMs: 0,
        ownerDocument: doc as unknown as Document,
        onDismiss,
      });

      doc.body.append(chip.element as unknown as FakeDOMElement);
      // If delay is 0, autoDismiss should not be scheduled (or dismissed immediately)
      vi.advanceTimersByTime(5000);
      expect(chip.element.isConnected).toBe(true);
      expect(onDismiss).not.toHaveBeenCalled();

      chip.dispose();
    });

    it("safely handles environments where Element is not defined on globalThis", () => {
      const originalElement = (globalThis as Record<string, unknown>)["Element"];
      try {
        delete (globalThis as Record<string, unknown>)["Element"];

        const transcriptRoot = doc.createElement("div");
        doc.body.append(transcriptRoot);

        expect(() => {
          const injector = installRendererTranscriptStatusInjector({
            root: transcriptRoot as unknown as ParentNode,
            ownerDocument: doc as unknown as Document,
          });
          injector.dispose();
        }).not.toThrow();
      } finally {
        if (originalElement !== undefined) {
          (globalThis as Record<string, unknown>)["Element"] = originalElement;
        }
      }
    });
  });
});
