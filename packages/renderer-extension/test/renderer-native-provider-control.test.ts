import { afterEach, describe, expect, it, vi } from "vitest";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { createRendererNativeProviderControl } from "../src/renderer-native-provider-control.js";
import { isComposerSubmitButton } from "../src/renderer-composer-dom.js";
import type { RendererModelClient } from "../src/renderer-model-client.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  class Element {
    textContent = "";
    title = "";
    className = "";
    type = "";
    hidden = false;
    disabled = false;
    isConnected = false;
    attributes = new Map<string, string>();
    children: Element[] = [];
    events = new Map<string, () => void>();
    ownerDocument = { createElement: () => new Element() };
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    hasAttribute(name: string) {
      return this.attributes.has(name);
    }
    getAttribute(name: string) {
      return this.attributes.get(name) ?? null;
    }
    addEventListener(name: string, listener: () => void) {
      this.events.set(name, listener);
    }
    append(...children: Element[]) {
      for (const child of children) {
        child.isConnected = true;
        this.children.push(child);
      }
    }
    remove() {
      this.isConnected = false;
    }
    click() {
      if (!this.disabled) this.events.get("click")?.();
    }
  }
  const container = new Element();
  container.isConnected = true;
  const inspect = vi.fn(async (): Promise<string | null> => "custom");
  const change = vi.fn(async () => {});
  const client = {
    inspectNativeProviderContinuation: inspect,
    continueNativeWithConfiguredProvider: change,
  } as unknown as RendererModelClient;
  const onChange = vi.fn();
  const control = createRendererNativeProviderControl(
    container as unknown as HTMLElement,
    onChange,
  );
  const threadId = hostThreadIdSchema.parse("history-thread");
  const update = (eligible = true) => control.update(client, threadId, eligible, "zh-CN");
  const child = (element: Element, index: number): Element => {
    const value = element.children[index];
    if (!value) throw new Error("Synthetic control child is missing");
    return value;
  };
  const root = () => child(container, 0);
  return {
    container,
    inspect,
    change,
    client,
    onChange,
    control,
    threadId,
    update,
    root,
    button: () => child(root(), 0),
    status: () => child(root(), 1),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Explicit historical Provider continuation control", () => {
  it("never recaptures the continuation action as native Send because of its tooltip", async () => {
    const f = fixture();
    f.update();
    await vi.waitFor(() => expect(f.root().hidden).toBe(false));
    f.button().title = "Continue with this Provider; do not send the draft";
    expect(isComposerSubmitButton(f.button() as unknown as HTMLButtonElement)).toBe(false);
    expect(f.button().attributes.has("data-codexhost-native-provider-continuation-action")).toBe(
      true,
    );
  });

  it("offers the verified Provider without resuming or sending anything", async () => {
    const f = fixture();
    f.update();
    expect(f.container.children).toHaveLength(0);
    await vi.waitFor(() => expect(f.button().textContent).toContain("custom"));
    expect(f.button().textContent).toContain("使用已配置");
    expect(f.button().title).toContain("不发送草稿");
    expect(f.root().hidden).toBe(false);
    expect(f.change).not.toHaveBeenCalled();
  });

  it("blocks duplicate clicks and exposes pending state before beginning the change", async () => {
    const f = fixture();
    const change = deferred<undefined>();
    f.change.mockReturnValue(change.promise);
    f.update();
    await vi.waitFor(() => expect(f.root().hidden).toBe(false));
    f.button().click();
    f.button().click();
    expect(f.control.pending).toBe(true);
    expect(f.control.blocked).toBe(true);
    expect(f.onChange).toHaveBeenCalledOnce();
    expect(f.change).toHaveBeenCalledExactlyOnceWith({ threadId: f.threadId }, "custom");
    expect(f.button().disabled).toBe(true);
    change.resolve(undefined);
    await vi.waitFor(() => expect(f.control.pending).toBe(false));
    expect(f.root().hidden).toBe(true);
    expect(f.onChange).toHaveBeenCalledTimes(2);
    expect(f.control.blocked).toBe(false);
  });

  it("keeps a failed continuation visible as an explicit error", async () => {
    const f = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    f.change.mockRejectedValue(new Error("Synthetic migration failed"));
    f.update();
    await vi.waitFor(() => expect(f.root().hidden).toBe(false));
    f.button().click();
    await vi.waitFor(() => expect(f.status().textContent).toContain("未能切换"));
    expect(f.control.pending).toBe(false);
    expect(f.control.blocked).toBe(true);
    expect(f.status().attributes.get("role")).toBe("alert");
    expect(console.warn).toHaveBeenCalledWith(
      "codexhost native Provider continuation failed",
      "Error",
    );
  });

  it("ignores an old Host/Thread proof after the Composer target changes", async () => {
    const f = fixture();
    const old = deferred<string | null>();
    f.inspect.mockReturnValue(old.promise);
    f.update();
    f.control.update(null, null, false, "zh-CN");
    old.resolve("custom");
    await Promise.resolve();
    await Promise.resolve();
    expect(f.container.children).toHaveLength(0);
    expect(f.change).not.toHaveBeenCalled();
  });

  it("does not inspect continuation when native ownership or eligibility is absent", () => {
    const f = fixture();
    f.update(false);
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.container.children).toHaveLength(0);
  });

  it("offers a verified official switchback even without an exhausted quota banner", async () => {
    const f = fixture();
    f.inspect.mockResolvedValue("cc-switch-official");
    f.update();
    await vi.waitFor(() => expect(f.button().textContent).toContain("cc-switch-official"));
    expect(f.button().title).toContain("原生登录");
    expect(f.button().title).toContain("Model");
    f.button().click();
    await vi.waitFor(() =>
      expect(f.change).toHaveBeenCalledExactlyOnceWith(
        { threadId: f.threadId },
        "cc-switch-official",
      ),
    );
  });

  it("fails closed and logs when the candidate cannot be inspected", async () => {
    const f = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    f.inspect.mockRejectedValue(new Error("Host disconnected"));
    f.update();
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(f.container.children).toHaveLength(0);
  });

  it("disposes its DOM and ignores late asynchronous proofs", async () => {
    const f = fixture();
    const old = deferred<string | null>();
    f.inspect.mockReturnValue(old.promise);
    f.update();
    f.control.dispose();
    old.resolve("custom");
    await Promise.resolve();
    await Promise.resolve();
    expect(f.container.children).toHaveLength(0);
    expect(f.onChange).not.toHaveBeenCalled();
  });

  it("removes a mounted continuation control on disposal", async () => {
    const f = fixture();
    f.update();
    await vi.waitFor(() => expect(f.root().hidden).toBe(false));
    f.control.dispose();
    expect(f.root().isConnected).toBe(false);
  });
});
