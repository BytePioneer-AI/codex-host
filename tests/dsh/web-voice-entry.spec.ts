// @vitest-environment jsdom
import { act, createElement, Fragment, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  VoiceInputButton,
  VoiceNotice,
} from "../../apps/web-ui/packages/client/ui-codexhost/src/client/VoiceInput.tsx";
import {
  VoiceInput,
  type VoiceInputState,
} from "../../apps/web-ui/packages/client/ui-codexhost/src/client/voice-input.ts";
import { voiceApi } from "../../apps/web-ui/packages/client/ui-codexhost/src/client/api.ts";
import { zh } from "../../apps/web-ui/packages/client/ui-codexhost/src/client/locales.ts";
vi.mock("../../apps/web-ui/packages/client/ui-codexhost/src/client/api.ts", () => ({
  voiceApi: { status: vi.fn() },
}));
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("refreshes availability on mount/visibility, shows the entry on HTTP and explains missing recording capability", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  expect(window.location.protocol).toBe("http:");
  vi.mocked(voiceApi.status).mockResolvedValue({ available: false });
  const voice = new VoiceInput(vi.fn());
  const block = { getSnapshot: () => undefined, subscribe: () => () => {} };
  const props = {
    voice,
    blocks: { storeFor: () => block },
    sessionId: "thread-a",
    inputActions: { captureInsertion: () => ({ draftRev: 1 }), insertText: vi.fn() },
    useInput: (select: (state: object) => unknown) => select({ phase: "plain" }),
    useSession: (select: (state: object) => unknown) => select({ removed: false }),
    t: (key: keyof typeof zh) => zh[key],
  } as unknown as ComponentProps<typeof VoiceInputButton>;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    act(() => root.unmount());
    voice.discard();
    container.remove();
  });
  const notice = { voice, t: props.t } as unknown as ComponentProps<typeof VoiceNotice>;
  await act(async () =>
    root.render(
      createElement(
        Fragment,
        null,
        createElement(VoiceInputButton, props),
        createElement(VoiceNotice, notice),
      ),
    ),
  );
  expect(container.querySelector("button")).toBeNull();
  expect(voiceApi.status).toHaveBeenCalledTimes(1);
  vi.mocked(voiceApi.status).mockResolvedValue({ available: true });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const button = container.querySelector("button");
  expect(button?.getAttribute("aria-label")).toBe("语音输入");
  expect(button?.disabled).toBe(false);
  vi.stubGlobal("MediaRecorder", undefined);
  await act(async () => button?.click());
  // The notice explains inside the composer; the entry itself stays visible.
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("HTTPS 或 localhost");
  expect(container.querySelector('button[aria-label="语音输入"]')).not.toBeNull();
  vi.mocked(voiceApi.status).mockResolvedValue({ available: false });
  await act(async () => {
    voice.discard();
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(container.querySelector("button")).toBeNull();
});

async function renderRecorder() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(voiceApi.status).mockResolvedValue({ available: true });
  let state: VoiceInputState = { phase: "idle", seconds: 0 };
  const listeners = new Set<() => void>();
  const voice = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bind: vi.fn(() => () => {}),
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(),
  };
  const block = { getSnapshot: () => undefined, subscribe: () => () => {} };
  const props = {
    voice,
    blocks: { storeFor: () => block },
    sessionId: "thread-a",
    inputActions: {},
    useInput: (select: (s: object) => unknown) => select({ phase: "plain" }),
    useSession: (select: (s: object) => unknown) => select({ removed: false }),
    t: (key: keyof typeof zh) => zh[key],
  } as unknown as ComponentProps<typeof VoiceInputButton>;
  const row = document.createElement("div");
  row.setAttribute("data-composer-toolbar", "");
  row.style.paddingLeft = "8px";
  row.innerHTML = "<div data-composer-tools></div><div data-trailing></div>";
  document.body.append(row);
  const container = row.querySelector<HTMLElement>("[data-trailing]")!;
  const root = createRoot(container);
  cleanup.push(() => {
    act(() => root.unmount());
    row.remove();
  });
  await act(async () => root.render(createElement(VoiceInputButton, props)));
  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  const update = async (next: VoiceInputState) => {
    await act(async () => {
      state = next;
      listeners.forEach((listener) => listener());
    });
  };
  return { voice, container, button, update };
}

it("keeps the microphone anchor across icon-only recording states and separates done from send", async () => {
  const { voice, container, button, update } = await renderRecorder();
  const anchor = container.firstElementChild;
  await act(async () => button("语音输入").click());
  expect(voice.start).toHaveBeenCalledOnce();
  await update({ phase: "recording", seconds: 8, levels: [0, 0, 0] });
  const meter = () => container.querySelector('svg[viewBox="0 0 96 24"]');
  // A quiet microphone draws one solid baseline, not a row of minimum-height dots.
  expect(meter()?.querySelectorAll("path")).toHaveLength(1);
  await update({ phase: "recording", seconds: 8, levels: [0.2, 0.8, 0.4] });
  expect(meter()?.querySelectorAll("path").length).toBeGreaterThan(1);
  for (const control of container.querySelectorAll("button")) {
    expect(control.textContent).toBe("");
    expect(control.querySelector("svg")).not.toBeNull();
  }
  await act(async () => button("结束录音并插入草稿").click());
  expect(voice.stop).toHaveBeenCalledOnce();
  expect(voice.send).not.toHaveBeenCalled();
  await act(async () => button("转写并发送").click());
  expect(voice.send).toHaveBeenCalledOnce();
  await update({ phase: "recording", seconds: 11, silent: true });
  expect(container.querySelector('[role="status"]')?.textContent).toBe("没有听到声音");
  expect(container.querySelector('[role="timer"]')?.textContent).toBe("0:11");
  await update({ phase: "transcribing", seconds: 11 });
  expect(container.firstElementChild).toBe(anchor);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("正在转写…");
  expect(container.querySelector('[role="timer"]')?.textContent).toBe("0:11");
  expect(button("结束录音并插入草稿").disabled).toBe(true);
  expect(button("转写并发送").disabled).toBe(true);
  expect(button("取消录音").disabled).toBe(false);
  await act(async () => {
    button("结束录音并插入草稿").click();
    button("转写并发送").click();
    button("取消录音").click();
  });
  expect(voice.stop).toHaveBeenCalledOnce();
  expect(voice.send).toHaveBeenCalledOnce();
  expect(voice.cancel).toHaveBeenCalledOnce();
});

it("reserves a folded tray while idle when toolbar space is insufficient, and on touch screens", async () => {
  const resizes: Array<() => void> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizes.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  let touch = false;
  vi.stubGlobal("matchMedia", () => ({ matches: touch }));
  let anchorLeft = 500;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    if (this.hasAttribute("data-composer-toolbar")) return new DOMRect(0, 0, 720, 160);
    if (this.hasAttribute("data-composer-tools")) return new DOMRect(8, 100, 150, 28);
    if (this.hasAttribute("data-composer-tray")) return new DOMRect(anchorLeft, 100, 28, 28);
    return new DOMRect();
  });
  const style = document.createElement("style");
  style.textContent = "[data-composer-tray] { --voice-bar-width: 229px; }";
  document.head.append(style);
  cleanup.push(() => style.remove());
  const { container, update } = await renderRecorder();
  const anchor = container.firstElementChild!;
  expect(anchor.getAttribute("data-composer-tray")).toBe("inline");
  await act(async () => {
    anchorLeft = 250;
    resizes.forEach((resize) => resize());
  });
  expect(anchor.getAttribute("data-composer-tray")).toBe("stacked");
  await update({ phase: "recording", seconds: 0 });
  expect(container.firstElementChild).toBe(anchor);
  expect(anchor.getAttribute("data-composer-tray")).toBe("stacked");
  await act(async () => {
    anchorLeft = 500;
    resizes.forEach((resize) => resize());
  });
  expect(anchor.getAttribute("data-composer-tray")).toBe("inline");
  await act(async () => {
    touch = true;
    resizes.forEach((resize) => resize());
  });
  expect(anchor.getAttribute("data-composer-tray")).toBe("stacked");
});
