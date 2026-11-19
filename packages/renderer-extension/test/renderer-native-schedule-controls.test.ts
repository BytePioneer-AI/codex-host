import { afterEach, describe, expect, it, vi } from "vitest";

const bindings = vi.hoisted(() => ({ read: vi.fn(), workspaces: vi.fn() }));
const pickers = vi.hoisted(() => [] as Array<{ value: string; change(): void }>);
vi.mock("@codexhost/desktop-control/renderer-bindings", () => ({
  readNativeScheduleForm: bindings.read,
  readNativeScheduleWorkspaces: bindings.workspaces,
  nativeScheduleModelRows: () => [],
}));
vi.mock("../src/renderer-agent-icon.js", () => ({ createRendererAgentIcon: () => null }));
vi.mock("../src/renderer-native-schedule-picker.js", () => ({
  schedulePickerStyles: "",
  createSchedulePicker: (document: Document, options: { onChange(): void }) => {
    const picker = {
      root: document.createElement("div"),
      value: "",
      change: options.onChange,
      setItems() {},
      setPlaceholder() {},
      setDisabledValues() {},
      close() {},
    };
    pickers.push(picker);
    return picker;
  },
}));
import { installRendererNativeScheduleControls } from "../src/renderer-native-schedule-controls.js";

class Node extends EventTarget {
  dataset = {};
  style = { setProperty() {} };
  hidden = false;
  textContent = "";
  isConnected = true;
  attributes = new Map<string, string>();
  children: Node[] = [];
  append(...nodes: Node[]) {
    this.children.push(...nodes);
  }
  prepend(node: Node) {
    this.children.unshift(node);
  }
  attachShadow() {
    const shadow = new Node();
    this.append(shadow);
    return shadow;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  querySelector: (selector: string) => Node | null = () => null;
  remove() {
    this.isConnected = false;
  }
  matches() {
    return false;
  }
}
function fixture({ ignoreTarget = false } = {}) {
  vi.useFakeTimers();
  pickers.length = 0;
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const workspace = { id: "project-a", cwd: "/work/项目 A", label: "项目 A" };
  bindings.workspaces.mockReturnValue([workspace]);
  const form = new Node();
  const submitButton = new Node();
  form.querySelector = (selector) => (selector === 'button[type="submit"]' ? submitButton : null);
  const saved = vi.fn();
  const submit = vi.fn(() => {
    if (form.dispatchEvent(new Event("submit", { cancelable: true }))) saved();
  });
  Object.assign(form, { requestSubmit: submit });
  const binding = {
    title: "Task",
    supportsExternal: true,
    isSaving: false,
    selection: { model: "gpt-native" as string | null, reasoningEffort: null },
    targetThreadId: null as string | null,
    get hasTarget() {
      return this.targetThreadId !== null;
    },
    setModel(selection: { model: string | null; reasoningEffort: null }) {
      this.selection = selection;
    },
    setTargetThread: vi.fn((threadId: string) => {
      if (!ignoreTarget) binding.targetThreadId = threadId;
    }),
  };
  bindings.read.mockImplementation(() => binding);
  const view = Object.assign(new EventTarget(), {
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
  });
  const nodes: Node[] = [];
  const document = Object.assign(new EventTarget(), {
    defaultView: view,
    documentElement: {},
    createElement() {
      const node = new Node();
      nodes.push(node);
      return node;
    },
    querySelectorAll: () => [form],
  });
  const client = {
    inspectHarness: vi.fn(async () => ({
      status: "ready",
      catalog: {
        models: [{ ref: { id: "selected" }, label: "Selected" }],
        defaultModel: { id: "selected" },
      },
    })),
  };
  const ready = Promise.withResolvers<{
    threadId: string;
    retain(): void;
    discard(): Promise<void>;
  }>();
  const createWorkspaceThread = vi.fn(() => ready.promise);
  const control = installRendererNativeScheduleControls(document as unknown as Document, {
    getClient: () => client as never,
    getAvailablePlugins: () => [{ id: "pi", name: "Pi" }] as never,
    subscribeAvailability: () => () => {},
    canRouteExternal: () => true,
    locale: () => "en",
    createWorkspaceThread,
  });
  const thread = { threadId: "new-empty", retain: vi.fn(), discard: vi.fn(async () => {}) };
  const choose = async () => {
    const harness = pickers[0],
      workspacePicker = pickers[2];
    if (!harness || !workspacePicker) throw Error("Schedule pickers are missing");
    harness.value = "pi";
    harness.change();
    await vi.advanceTimersByTimeAsync(1);
    workspacePicker.value = workspace.id;
    workspacePicker.change();
    await vi.advanceTimersByTimeAsync(1);
  };
  const message = () => {
    const status = nodes.find((node) => node.attributes.get("role") === "status");
    if (!status) throw Error("Schedule status is missing");
    return status.textContent;
  };
  return { choose, submit, saved, ready, thread, binding, createWorkspaceThread, control, message };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("workspace preparation submit guard", () => {
  it("blocks overlapping submissions and submits the confirmed target exactly once", async () => {
    const f = fixture();
    await f.choose();
    f.submit();
    f.submit();
    expect(f.createWorkspaceThread).toHaveBeenCalledTimes(1);
    expect(f.saved).not.toHaveBeenCalled();
    f.ready.resolve(f.thread);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.saved).toHaveBeenCalledTimes(1);
    expect(f.binding.targetThreadId).toBe(f.thread.threadId);
    expect(f.thread.retain).toHaveBeenCalledTimes(1);
    expect(f.thread.discard).not.toHaveBeenCalled();
    f.control.dispose();
  });

  it("awaits cleanup after target confirmation failure and never recreates on resubmission", async () => {
    const f = fixture({ ignoreTarget: true });
    await f.choose();
    const cleanup = Promise.withResolvers<undefined>();
    f.thread.discard.mockReturnValue(cleanup.promise);
    f.submit();
    f.ready.resolve(f.thread);
    await vi.advanceTimersByTimeAsync(5100);
    expect(f.thread.discard).toHaveBeenCalledTimes(1);
    expect(f.saved).not.toHaveBeenCalled();
    f.submit();
    expect(f.createWorkspaceThread).toHaveBeenCalledTimes(1);
    cleanup.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.message()).toContain("target chat was not confirmed");
    f.submit();
    expect(f.createWorkspaceThread).toHaveBeenCalledTimes(1);
    f.control.dispose();
  });

  it("reports RPC cleanup failure rather than saving or silently enabling creation again", async () => {
    const f = fixture({ ignoreTarget: true });
    await f.choose();
    f.thread.discard.mockRejectedValue(Error("archive unavailable"));
    f.submit();
    f.ready.resolve(f.thread);
    await vi.advanceTimersByTimeAsync(5100);
    expect(f.message()).toContain("Chat cleanup failed: archive unavailable");
    f.submit();
    expect(f.createWorkspaceThread).toHaveBeenCalledTimes(1);
    expect(f.saved).not.toHaveBeenCalled();
    f.control.dispose();
  });

  it("keeps an unknown native outcome locked without submitting a target", async () => {
    const f = fixture();
    await f.choose();
    f.submit();
    f.ready.reject(Error("Creation outcome unknown"));
    await vi.advanceTimersByTimeAsync(1);
    expect(f.message()).toContain("Check the chat list before creating another task");
    f.submit();
    expect(f.createWorkspaceThread).toHaveBeenCalledTimes(1);
    expect(f.binding.setTargetThread).not.toHaveBeenCalled();
    expect(f.saved).not.toHaveBeenCalled();
    f.control.dispose();
  });
});
