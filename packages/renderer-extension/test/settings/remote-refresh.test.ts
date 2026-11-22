import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeStatus } from "@codexhost/shared-contracts";
import type { CodexSshConnection } from "../../src/codex-ssh-adapter.js";
import type {
  RemoteCardAction,
  RemoteConnectionRow,
} from "../../src/settings/remote-connections-card.js";
import { createRemoteConnectionsPage } from "../../src/settings/remote-connections-page.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";

const ui = vi.hoisted(() => ({
  actions: new Map<string, (action: RemoteCardAction) => void>(),
  rows: new Map<string, RemoteConnectionRow>(),
}));
vi.mock("../../src/settings/icons.js", () => ({ createRendererSettingsIcon: () => "icon" }));
vi.mock("../../src/settings/remote-connections-card.js", async (original) => ({
  ...(await original<object>()),
  renderRemoteCard(
    document: Document,
    row: RemoteConnectionRow,
    _local: unknown,
    _text: unknown,
    action: (action: RemoteCardAction) => void,
  ) {
    ui.rows.set(row.connection.hostId, row);
    ui.actions.set(row.connection.hostId, action);
    return document.createElement("article");
  },
}));

class Element extends EventTarget {
  children: unknown[] = [];
  className = "";
  title = "";
  textContent = "";
  hidden = false;
  parent: Element | undefined;
  attributes = new Map<string, string>();
  constructor(readonly ownerDocument: DocumentFixture) {
    super();
  }
  append(...values: unknown[]) {
    for (const value of values) if (value instanceof Element) value.parent = this;
    this.children.push(...values);
  }
  replaceChildren(...values: unknown[]) {
    this.children = [];
    this.append(...values);
  }
  insertBefore(value: Element, before?: unknown) {
    value.remove();
    const index = this.children.indexOf(before);
    this.children.splice(index < 0 ? this.children.length : index, 0, value);
    value.parent = this;
  }
  replaceWith(value: Element) {
    const parent = this.parent;
    if (parent) {
      parent.insertBefore(value, this);
      this.remove();
    }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((value) => value !== this);
    this.parent = undefined;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  getRootNode() {
    return this.ownerDocument;
  }
  querySelector() {
    return null;
  }
  contains() {
    return false;
  }
}
class DocumentFixture extends EventTarget {
  visibilityState = "visible";
  activeElement = null;
  createElement() {
    return new Element(this);
  }
}
const status = (): RuntimeStatus => ({
  runningVersion: "0.13.2",
  installedVersion: "0.13.2",
  remote: true,
  restartRequired: false,
  updateSupported: true,
  update: { phase: "idle", targetVersion: null, error: null },
});
const connection = (hostId: string): CodexSshConnection => ({
  hostId,
  displayName: hostId,
  source: "codex-managed",
  sshHost: hostId,
  sshAlias: null,
  sshPort: 22,
  identity: null,
  autoConnect: true,
});
const settle = () => vi.advanceTimersByTimeAsync(0);
function setup() {
  vi.useFakeTimers();
  vi.stubGlobal("HTMLElement", Element);
  ui.actions.clear();
  ui.rows.clear();
  const document = new DocumentFixture();
  const content = document.createElement();
  const controller = new AbortController();
  const control = {
    ssh: {
      list: vi.fn(async () => [connection("host")]),
      state: vi.fn<(host: string) => Promise<{ state: string; error: string | null }>>(
        async () => ({ state: "connected", error: null }),
      ),
      connect: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
    runtime: vi.fn<(host: string) => Promise<RuntimeStatus>>(async () => status()),
    setup: vi.fn(async () => ({ state: "installed" as const })),
    update: vi.fn(async () => status()),
  };
  const mount = () =>
    createRemoteConnectionsPage(rendererSettingsMessages("zh-CN"), () => control).mount({
      content: content as unknown as HTMLElement,
      signal: controller.signal,
      runLatest: vi.fn(),
    });
  const visible = (shown: boolean) => {
    document.visibilityState = shown ? "visible" : "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const refresh = () => {
    const walk = (element: Element): Element[] => [
      element,
      ...element.children.flatMap((child) => (child instanceof Element ? walk(child) : [])),
    ];
    walk(content)
      .find((element) => element.title === "刷新")
      ?.dispatchEvent(new Event("click"));
  };
  return { control, document, controller, content, mount, visible, refresh };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("pauses hidden remote queries, refreshes on visibility recovery and cleans up on leave", async () => {
  const b = setup();
  const dispose = b.mount();
  await settle();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(b.control.ssh.list).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(b.control.ssh.list).toHaveBeenCalledTimes(2);
  b.visible(false);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(b.control.ssh.list).toHaveBeenCalledTimes(2);
  b.visible(true);
  b.visible(true);
  await settle();
  expect(b.control.ssh.list).toHaveBeenCalledTimes(3);
  b.refresh();
  await settle();
  expect(b.control.ssh.list).toHaveBeenCalledTimes(4);
  dispose?.();
  b.visible(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(b.control.ssh.list).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps fast checks during remote updates and failures, then returns to the stable interval", async () => {
  const b = setup();
  b.control.runtime.mockImplementation(async (host) =>
    host === "local"
      ? status()
      : {
          ...status(),
          update: { phase: "installing", targetVersion: "0.13.3", error: null },
        },
  );
  const dispose = b.mount();
  await settle();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(b.control.ssh.list).toHaveBeenCalledTimes(2);
  b.control.runtime.mockResolvedValue(status());
  await vi.advanceTimersByTimeAsync(5_000);
  expect(b.control.ssh.list).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(b.control.ssh.list).toHaveBeenCalledTimes(3);
  b.control.ssh.list.mockRejectedValueOnce(new Error("list unavailable"));
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(b.control.ssh.list).toHaveBeenCalledTimes(5);
  dispose?.();
});

it("merges visibility queries, keeps actions responsive with one slow Host and ignores late results after abort", async () => {
  const b = setup();
  b.control.ssh.list.mockResolvedValue([connection("host"), connection("slow")]);
  const releases: Array<(value: RuntimeStatus) => void> = [];
  b.control.runtime.mockImplementation(async (host) =>
    host === "slow"
      ? new Promise<RuntimeStatus>((done) => {
          releases.push(done);
        })
      : status(),
  );
  b.mount();
  await settle();
  expect(ui.rows.get("host")?.remote?.runningVersion).toBe("0.13.2");
  b.visible(false);
  b.visible(true);
  await settle();
  expect(b.control.ssh.list).toHaveBeenCalledOnce();
  ui.actions.get("host")?.("toggle");
  await settle();
  expect(b.control.ssh.connect).toHaveBeenCalledOnce();
  expect(ui.rows.get("host")?.pending).toBeNull();
  const content = JSON.stringify(b.content.children, (key, value) =>
    key === "parent" || key === "ownerDocument" ? undefined : value,
  );
  b.controller.abort();
  for (const release of releases) release(status());
  await settle();
  expect(
    JSON.stringify(b.content.children, (key, value) =>
      key === "parent" || key === "ownerDocument" ? undefined : value,
    ),
  ).toBe(content);
  b.visible(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(b.control.ssh.list).toHaveBeenCalledTimes(2);
});

it("polls other hosts during an operation and confirms the acted host immediately afterwards", async () => {
  const b = setup();
  const dispose = b.mount();
  await settle();
  let release = () => {};
  b.control.setup.mockImplementationOnce(async () => {
    await new Promise<void>((done) => {
      release = done;
    });
    return { state: "installed" };
  });
  ui.actions.get("host")?.("repair");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(b.control.ssh.list).toHaveBeenCalledTimes(2);
  expect(b.control.ssh.state).toHaveBeenCalledTimes(1);
  release();
  await settle();
  expect(b.control.ssh.state).toHaveBeenCalledTimes(2);
  expect(ui.rows.get("host")?.pending).toBeNull();
  expect(b.control.setup).toHaveBeenCalledOnce();
  dispose?.();
});

it("performs a fresh manual inspection after an in-flight check finishes", async () => {
  const b = setup();
  b.control.runtime.mockImplementation(async (host) => {
    if (host !== "local") throw new Error("runtime unavailable");
    return status();
  });
  let release = () => {};
  b.control.setup.mockImplementationOnce(async () => {
    await new Promise<void>((done) => {
      release = done;
    });
    return { state: "installed" };
  });
  const dispose = b.mount();
  await settle();
  expect(b.control.setup).toHaveBeenCalledOnce();
  b.refresh();
  await settle();
  expect(b.control.ssh.list).toHaveBeenCalledOnce();
  release();
  await settle();
  expect(b.control.ssh.list).toHaveBeenCalledTimes(2);
  expect(b.control.setup).toHaveBeenCalledTimes(2);
  dispose?.();
});
