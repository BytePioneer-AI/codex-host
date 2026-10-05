import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

class ElementStub {
  children: ElementStub[] = [];
  dataset = {};
  value = "";
  disabled = false;
  text = "";
  listeners = new Map<string, (event: unknown) => void>();

  constructor(readonly tag = "div") {}

  empty(): void {
    this.children = [];
  }
  addClass(): void {}
  setText(text: string): void {
    this.text = text;
  }
  createEl(tag: string, options: { text?: string } = {}): ElementStub {
    const child = new ElementStub(tag);
    child.text = options.text ?? "";
    this.children.push(child);
    return child;
  }
  createDiv(options = {}): ElementStub {
    return this.createEl("div", options);
  }
  createSpan(options = {}): ElementStub {
    return this.createEl("span", options);
  }
  addEventListener(type: string, callback: (event: unknown) => void): void {
    this.listeners.set(type, callback);
  }
  find(tag: string): ElementStub {
    if (this.tag === tag) return this;
    for (const child of this.children) {
      try {
        return child.find(tag);
      } catch {
        /* Keep looking. */
      }
    }
    throw new Error(`Missing ${tag}`);
  }
  keydown(options: { isComposing?: boolean; keyCode?: number; shiftKey?: boolean } = {}) {
    const event = { key: "Enter", preventDefault: vi.fn(), ...options };
    this.listeners.get("keydown")?.(event);
    return event;
  }
}

vi.mock("obsidian", () => ({
  ItemView: class {
    contentEl = new ElementStub();
    app = { vault: { adapter: new (class {})() } };
  },
  FileSystemAdapter: class {
    getBasePath() {
      return "/vault";
    }
  },
  Modal: class {},
  Notice: class {},
  Plugin: class {
    factory!: () => TestView;
    registerView(_type: string, factory: () => TestView) {
      this.factory = factory;
    }
    addRibbonIcon() {}
    addCommand() {}
  },
}));

const connect = vi.hoisted(() => vi.fn());
vi.mock("@codexhost/client", () => ({
  CodexHostClient: { connect },
  externalHarnessTransportModel: vi.fn(),
}));

import { FileSystemAdapter } from "obsidian";
import Plugin from "../src/main.js";

interface TestView {
  contentEl: ElementStub;
  app: { vault: { adapter: unknown } };
  onOpen(): Promise<void>;
}

let client: EventEmitter & {
  request: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  descriptor: { port: number };
};
let view: TestView;
let input: ElementStub;

beforeEach(async () => {
  client = Object.assign(new EventEmitter(), {
    descriptor: { port: 1234 },
    close: vi.fn(),
    request: vi.fn(async (method: string): Promise<unknown> => {
      if (method === "model/list") return { data: [{ model: "codex", isDefault: true }] };
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      return { plugins: [] };
    }),
  });
  connect.mockResolvedValue(client);
  const plugin = new Plugin({} as never, {} as never);
  await plugin.onload();
  view = (plugin as unknown as { factory(): TestView }).factory();
  view.app.vault.adapter = new FileSystemAdapter();
  await view.onOpen();
  input = view.contentEl.find("textarea");
});

function requests(method: string) {
  return client.request.mock.calls.filter(([name]) => name === method);
}

describe("Obsidian chat submission", () => {
  it.each([{ isComposing: true }, { isComposing: false, keyCode: 229 }])(
    "does not submit an IME confirmation Enter (%j)",
    async (event) => {
      input.value = "回复ok";
      expect(input.keydown(event).preventDefault).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(requests("thread/start")).toHaveLength(0);
      expect(input.value).toBe("回复ok");
      input.keydown();
      await vi.waitFor(() => expect(requests("turn/start")).toHaveLength(1));
      expect(requests("turn/start")[0]?.[1]).toMatchObject({
        input: [{ type: "text", text: "回复ok" }],
      });
    },
  );

  it("keeps one thread and one turn while thread creation is pending", async () => {
    let resolveThread!: (value: unknown) => void;
    client.request.mockImplementation((method: string) => {
      if (method === "thread/start")
        return new Promise((resolve) => {
          resolveThread = resolve;
        });
      return Promise.resolve({ turn: { id: "turn-1" } });
    });
    input.value = "回复ok";
    input.keydown();
    input.value = "ok";
    input.keydown();
    expect(requests("thread/start")).toHaveLength(1);
    expect(input.value).toBe("ok");
    resolveThread({ thread: { id: "thread-1" } });
    await vi.waitFor(() => expect(requests("turn/start")).toHaveLength(1));
    input.keydown();
    expect(requests("turn/start")).toHaveLength(1);
    client.emit("notification", "item/agentMessage/delta", { threadId: "thread-1", delta: "ok" });
    client.emit("notification", "turn/completed", { threadId: "thread-1" });
    const cards = view.contentEl.children[1]?.children;
    expect(cards?.map((card) => card.children.map((child) => child.text))).toEqual([
      ["user", "回复ok"],
      ["assistant", "ok"],
    ]);
    expect(requests("turn/start")).toHaveLength(1);
  });

  it("allows retry after thread creation fails", async () => {
    client.request.mockRejectedValueOnce(new Error("Thread failed"));
    input.value = "first";
    input.keydown();
    await vi.waitFor(() => expect(view.contentEl.children[1]?.children).toHaveLength(2));
    input.value = "retry";
    input.keydown();
    await vi.waitFor(() => expect(requests("turn/start")).toHaveLength(1));
    expect(requests("thread/start")).toHaveLength(2);
  });

  it("allows the next turn when completion arrives before the start response", async () => {
    let resolveTurn!: (value: unknown) => void;
    client.request.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      return new Promise((resolve) => {
        resolveTurn = resolve;
      });
    });
    input.value = "first";
    input.keydown();
    await vi.waitFor(() => expect(requests("turn/start")).toHaveLength(1));
    client.emit("notification", "item/agentMessage/delta", { threadId: "thread-1", delta: "ok" });
    client.emit("notification", "turn/completed", { threadId: "thread-1" });
    resolveTurn({ turn: { id: "turn-1" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.value = "next";
    input.keydown();
    await vi.waitFor(() => expect(requests("turn/start")).toHaveLength(2));
    expect(requests("thread/start")).toHaveLength(1);
    resolveTurn({ turn: { id: "turn-2" } });
  });
});
