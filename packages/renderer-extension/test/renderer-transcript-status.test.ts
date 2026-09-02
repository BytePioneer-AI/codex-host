import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHINESE_STATUS_MESSAGES,
  DEFAULT_STATUS_AUTO_DISMISS_DELAY_MS,
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
import { transitionRendererAdapterStatus } from "../src/versioned-renderer-adapter.js";

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
    const bracketIndex = selector.indexOf("[");
    if (bracketIndex !== -1 && selector.endsWith("]")) {
      const tag = selector.slice(0, bracketIndex).trim();
      if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) {
        return false;
      }
      const raw = selector.slice(bracketIndex + 1, -1);
      if (raw.includes("*=")) {
        const [attr, val] = raw.split("*=");
        const cleanVal = val?.replace(/['"]/g, "");
        if (attr && cleanVal) {
          return (this.getAttribute(attr) ?? "").includes(cleanVal);
        }
        return false;
      }
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
    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      return this.className.split(/\s+/).includes(className);
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
  public target: FakeDOMElement | null = null;
  public callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
    FakeMutationObserver.instances.push(this);
  }

  observe(target: FakeDOMElement): void {
    this.target = target;
  }

  disconnect(): void {
    this.target = null;
    FakeMutationObserver.instances = FakeMutationObserver.instances.filter((i) => i !== this);
  }

  static trigger(): void {
    for (const inst of [...FakeMutationObserver.instances]) {
      inst.callback();
    }
  }
}

class FakeDOMDocument {
  public head: FakeDOMElement;
  public body: FakeDOMElement;
  public documentElement: FakeDOMElement;
  public defaultView: {
    MutationObserver: typeof FakeMutationObserver;
    addEventListener: (type: string, cb: (e: unknown) => void) => void;
    removeEventListener: (type: string, cb: (e: unknown) => void) => void;
    dispatchEvent: (event: unknown) => void;
  };
  private globalListeners: MockListener[] = [];

  constructor() {
    this.documentElement = new FakeDOMElement("html", this);
    this.head = new FakeDOMElement("head", this);
    this.body = new FakeDOMElement("body", this);
    this.documentElement.append(this.head, this.body);

    this.defaultView = {
      MutationObserver: FakeMutationObserver,
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
        for (const l of this.globalListeners) {
          if (l.type === type) {
            l.callback(event);
          }
        }
      },
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

describe("Transcript status indicator & localization", () => {
  let doc: FakeDOMDocument;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new FakeDOMDocument();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("exports correct English and Chinese localized message dictionaries", () => {
    expect(ENGLISH_STATUS_MESSAGES).toEqual({
      ready: "Ready",
      running: "Running...",
      completed: "Completed",
      failed: "Failed",
      interrupted: "Interrupted",
    });

    expect(CHINESE_STATUS_MESSAGES).toEqual({
      ready: "就绪",
      running: "运行中...",
      completed: "已完成",
      failed: "执行失败",
      interrupted: "已中断",
    });

    expect(transcriptStatusMessages("en")).toEqual(ENGLISH_STATUS_MESSAGES);
    expect(transcriptStatusMessages("zh-CN")).toEqual(CHINESE_STATUS_MESSAGES);
    expect(DEFAULT_STATUS_AUTO_DISMISS_DELAY_MS).toBe(3000);
  });

  it("renders status chip element with correct classes, attributes, and text for all states", () => {
    const states: AdapterStatusState[] = ["ready", "running", "completed", "failed", "interrupted"];

    for (const state of states) {
      const chip = mountRendererTranscriptStatusChip({
        status: state,
        locale: "en",
        ownerDocument: doc as unknown as Document,
      });

      expect(chip.element.getAttribute(TRANSCRIPT_STATUS_CHIP_ATTRIBUTE)).toBe("true");
      expect(chip.element.getAttribute(TRANSCRIPT_STATUS_STATE_ATTRIBUTE)).toBe(state);
      expect(chip.element.className).toContain("codexhost-trigger-chip");
      expect(chip.element.className).toContain("codexhost-transcript-status-chip");
      expect(chip.element.getAttribute("role")).toBe("status");

      // Verify English text
      expect(chip.element.textContent).toContain(ENGLISH_STATUS_MESSAGES[state]);
      chip.dispose();
    }
  });

  it("supports dynamic Chinese localization and locale switching", () => {
    const chip = mountRendererTranscriptStatusChip({
      status: "running",
      locale: "zh-CN",
      ownerDocument: doc as unknown as Document,
    });

    expect(chip.element.textContent).toContain("运行中...");

    chip.setStatus("failed");
    expect(chip.element.textContent).toContain("执行失败");

    chip.setLocale("en");
    expect(chip.element.textContent).toContain("Failed");

    chip.setLocale("zh-CN");
    expect(chip.element.textContent).toContain("执行失败");

    chip.dispose();
  });

  it("performs 3-second auto-removal when status is completed", () => {
    const chip = mountRendererTranscriptStatusChip({
      status: "ready",
      locale: "en",
      ownerDocument: doc as unknown as Document,
    });

    doc.body.append(chip.element as unknown as FakeDOMElement);
    expect(chip.element.isConnected).toBe(true);

    // Initial ready state should not auto-remove
    vi.advanceTimersByTime(3000);
    expect(chip.element.isConnected).toBe(true);

    // Transition to completed
    chip.setStatus("completed");
    expect(chip.element.isConnected).toBe(true);
    expect(chip.element.getAttribute(TRANSCRIPT_STATUS_STATE_ATTRIBUTE)).toBe("completed");

    // At 2999ms, chip should still be in DOM
    vi.advanceTimersByTime(2999);
    expect(chip.element.isConnected).toBe(true);

    // At 3000ms, chip should be removed from DOM
    vi.advanceTimersByTime(1);
    expect(chip.element.isConnected).toBe(false);

    chip.dispose();
  });

  it("cancels auto-removal timer when status changes from completed to running", () => {
    const chip = mountRendererTranscriptStatusChip({
      status: "completed",
      locale: "en",
      ownerDocument: doc as unknown as Document,
    });

    doc.body.append(chip.element as unknown as FakeDOMElement);
    expect(chip.element.isConnected).toBe(true);

    // Advance 1500ms
    vi.advanceTimersByTime(1500);
    expect(chip.element.isConnected).toBe(true);

    // New turn starts: status transitions to running
    chip.setStatus("running");
    expect(chip.element.getAttribute(TRANSCRIPT_STATUS_STATE_ATTRIBUTE)).toBe("running");

    // Advance past 3000ms mark (another 2000ms)
    vi.advanceTimersByTime(2000);
    expect(chip.element.isConnected).toBe(true);
    expect(chip.element.textContent).toContain("Running...");

    chip.dispose();
  });

  it("supports custom autoDismissDelayMs", () => {
    const chip = mountRendererTranscriptStatusChip({
      status: "completed",
      autoDismissDelayMs: 5000,
      ownerDocument: doc as unknown as Document,
    });

    doc.body.append(chip.element as unknown as FakeDOMElement);
    expect(chip.element.isConnected).toBe(true);

    vi.advanceTimersByTime(3000);
    expect(chip.element.isConnected).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(chip.element.isConnected).toBe(false);

    chip.dispose();
  });

  it("cleans up timers and DOM elements cleanly on dispose() without leaks", () => {
    const onDismiss = vi.fn();
    const chip = mountRendererTranscriptStatusChip({
      status: "completed",
      ownerDocument: doc as unknown as Document,
      onDismiss,
    });

    doc.body.append(chip.element as unknown as FakeDOMElement);
    expect(chip.element.isConnected).toBe(true);

    chip.dispose();
    expect(chip.element.isConnected).toBe(false);

    // Advance timers - no pending action or duplicate dismissal should fire
    vi.advanceTimersByTime(5000);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("Transcript status injector", () => {
  let doc: FakeDOMDocument;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new FakeDOMDocument();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("finds transcript targets in the DOM hierarchy", () => {
    const turn1 = doc.createElement("div");
    turn1.setAttribute("data-turn-key", "turn-1");
    doc.body.append(turn1);

    expect(findTranscriptTarget(doc as unknown as Document)).toBe(turn1);

    const turn2 = doc.createElement("div");
    turn2.setAttribute("data-turn-key", "turn-2");
    doc.body.append(turn2);

    expect(findTranscriptTarget(doc as unknown as Document)).toBe(turn2);
  });

  it("attaches container and chip into transcript target and handles updates", () => {
    const transcriptContainer = doc.createElement("div");
    transcriptContainer.setAttribute("data-testid", "conversation-turns");
    doc.body.append(transcriptContainer);

    const injector = installRendererTranscriptStatusInjector({
      root: transcriptContainer as unknown as ParentNode,
      ownerDocument: doc as unknown as Document,
      getLocale: () => "zh-CN",
    });

    expect(injector.getStatus()).toBe("ready");
    const container = transcriptContainer.querySelector(
      `[${TRANSCRIPT_STATUS_CONTAINER_ATTRIBUTE}]`,
    );
    expect(container).not.toBeNull();
    expect(container?.getAttribute(TRANSCRIPT_STATUS_CONTAINER_ATTRIBUTE)).toBe("true");

    // Status transition to running
    injector.setStatus("running");
    expect(injector.getStatus()).toBe("running");
    expect(container?.textContent).toContain("运行中...");

    // Status transition to completed -> auto dismisses after 3000ms
    injector.setStatus("completed");
    expect(container?.textContent).toContain("已完成");

    vi.advanceTimersByTime(3000);
    expect(container?.querySelector(`[${TRANSCRIPT_STATUS_CHIP_ATTRIBUTE}]`)).toBeNull();

    // Re-triggering running re-attaches chip
    injector.setStatus("running");
    expect(container?.querySelector(`[${TRANSCRIPT_STATUS_CHIP_ATTRIBUTE}]`)).not.toBeNull();
    expect(container?.textContent).toContain("运行中...");

    injector.dispose();
    expect(
      transcriptContainer.querySelector(`[${TRANSCRIPT_STATUS_CONTAINER_ATTRIBUTE}]`),
    ).toBeNull();
  });

  it("responds to window custom events for status and locale changes", () => {
    const transcriptRoot = doc.createElement("div");
    transcriptRoot.setAttribute("data-transcript-root", "true");
    doc.body.append(transcriptRoot);

    const injector = installRendererTranscriptStatusInjector({
      root: transcriptRoot as unknown as ParentNode,
      ownerDocument: doc as unknown as Document,
    });

    // Dispatch status event via defaultView
    doc.defaultView.dispatchEvent({
      type: "codexhost:transcript-status",
      detail: { status: "running", locale: "zh-CN" },
    });

    expect(injector.getStatus()).toBe("running");
    expect(injector.chip.locale).toBe("zh-CN");
    expect(injector.chip.element.textContent).toContain("运行中...");

    doc.defaultView.dispatchEvent({
      type: "codexhost:transcript-status-changed",
      detail: { status: "interrupted", locale: "en" },
    });

    expect(injector.getStatus()).toBe("interrupted");
    expect(injector.chip.locale).toBe("en");
    expect(injector.chip.element.textContent).toContain("Interrupted");

    injector.dispose();
  });

  it("automatically tracks live turn running and completion based on DOM state", () => {
    const transcriptRoot = doc.createElement("div");
    transcriptRoot.setAttribute("data-transcript-root", "true");
    doc.body.append(transcriptRoot);

    const injector = installRendererTranscriptStatusInjector({
      root: transcriptRoot as unknown as ParentNode,
      ownerDocument: doc as unknown as Document,
      getLocale: () => "zh-CN",
    });

    expect(injector.getStatus()).toBe("ready");

    // Simulate user clicking send -> composer mounts stop button
    const stopButton = doc.createElement("button");
    stopButton.setAttribute("data-testid", "composer-stop-button");
    transcriptRoot.append(stopButton);

    // Trigger observer callback
    doc.body.children = [...doc.body.children];
    doc.defaultView.MutationObserver.trigger();

    expect(injector.getStatus()).toBe("running");
    expect(injector.chip.element.textContent).toContain("运行中...");

    // Simulate turn finished -> stop button removed
    stopButton.remove();
    doc.defaultView.MutationObserver.trigger();

    expect(injector.getStatus()).toBe("completed");
    expect(injector.chip.element.textContent).toContain("已完成");

    // Auto-dismisses after 3 seconds
    vi.advanceTimersByTime(3000);
    const container = transcriptRoot.querySelector(`[${TRANSCRIPT_STATUS_CONTAINER_ATTRIBUTE}]`);
    expect(container?.querySelector(`[${TRANSCRIPT_STATUS_CHIP_ATTRIBUTE}]`)).toBeNull();

    injector.dispose();
  });

  it("handles attribute-only mutation on reused composer button", () => {
    const transcriptRoot = doc.createElement("div");
    transcriptRoot.setAttribute("data-transcript-root", "true");
    doc.body.append(transcriptRoot);

    const actionButton = doc.createElement("button");
    actionButton.setAttribute("aria-label", "Send prompt");
    transcriptRoot.append(actionButton);

    const injector = installRendererTranscriptStatusInjector({
      root: transcriptRoot as unknown as ParentNode,
      ownerDocument: doc as unknown as Document,
      getLocale: () => "en",
    });

    expect(injector.getStatus()).toBe("ready");

    // Reused button switches aria-label to Stop without DOM insertion/deletion
    actionButton.setAttribute("aria-label", "Stop generating");
    FakeMutationObserver.trigger();

    expect(injector.getStatus()).toBe("running");

    // Reused button switches back to Send
    actionButton.setAttribute("aria-label", "Send prompt");
    FakeMutationObserver.trigger();

    expect(injector.getStatus()).toBe("completed");
    injector.dispose();
  });

  it("does not let historical failed turn pollute subsequent successful turn", () => {
    const transcriptRoot = doc.createElement("div");
    transcriptRoot.setAttribute("data-transcript-root", "true");
    doc.body.append(transcriptRoot);

    // Turn 1 (historical failure)
    const turn1 = doc.createElement("div");
    turn1.setAttribute("data-turn-key", "turn-1");
    const errorNode = doc.createElement("div");
    errorNode.setAttribute("data-testid", "turn-error");
    turn1.append(errorNode);
    transcriptRoot.append(turn1);

    // Turn 2 (current turn)
    const turn2 = doc.createElement("div");
    turn2.setAttribute("data-turn-key", "turn-2");
    const stopButton = doc.createElement("button");
    stopButton.setAttribute("data-testid", "composer-stop-button");
    turn2.append(stopButton);
    transcriptRoot.append(turn2);

    const injector = installRendererTranscriptStatusInjector({
      root: transcriptRoot as unknown as ParentNode,
      ownerDocument: doc as unknown as Document,
      getLocale: () => "en",
    });

    FakeMutationObserver.trigger();
    expect(injector.getStatus()).toBe("running");

    // Turn 2 succeeds and unmounts stop button
    stopButton.remove();
    FakeMutationObserver.trigger();

    // Turn 2 must be completed, NOT failed by Turn 1's errorNode
    expect(injector.getStatus()).toBe("completed");
    injector.dispose();
  });

  it("does not treat adapter installing state as turn running or fake completed on ready", () => {
    const transcriptRoot = doc.createElement("div");
    transcriptRoot.setAttribute("data-transcript-root", "true");
    doc.body.append(transcriptRoot);

    const injector = installRendererTranscriptStatusInjector({
      root: transcriptRoot as unknown as ParentNode,
      ownerDocument: doc as unknown as Document,
      getLocale: () => "en",
    });

    // Adapter reports installing state
    doc.defaultView.dispatchEvent({
      type: "codexhost:renderer-adapter-status",
      detail: { state: "installing" },
    });
    expect(injector.getStatus()).toBe("ready");

    // Adapter reports ready state
    doc.defaultView.dispatchEvent({
      type: "codexhost:renderer-adapter-status",
      detail: { state: "ready" },
    });
    expect(injector.getStatus()).toBe("ready");

    // Arbitrary subsequent DOM mutation should keep status ready (not falsely trigger completed)
    FakeMutationObserver.trigger();
    expect(injector.getStatus()).toBe("ready");

    injector.dispose();
  });

  it("integrates into versioned renderer adapter with full lifecycle cleanup", () => {
    // Verify adapter status transition logic
    const status = {
      state: "installing" as const,
      reason: "installing" as const,
      modelUpdates: 0,
      hook: null,
    };
    const publish = vi.fn();
    expect(
      transitionRendererAdapterStatus(
        status,
        { state: "ready", reason: "ready", hook: "request-bridge" },
        publish,
      ),
    ).toBe(true);
    expect(status.state).toBe("ready");
  });
});
