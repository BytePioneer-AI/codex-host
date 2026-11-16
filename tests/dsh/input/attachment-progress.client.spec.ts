// @vitest-environment jsdom
import { act, createElement, type ComponentProps, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { ComposerAttachments } from "../../../apps/web-ui/packages/client/ui-attachment/src/client/ComposerAttachments.tsx";
import { PendingSubmissionBubble } from "../../../apps/web-ui/packages/client/ui-chat/src/client/chat/MessageItem.tsx";
import { en, zh } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/locales.ts";
import {
  en as chatEn,
  zh as chatZh,
} from "../../../apps/web-ui/packages/client/ui-chat/src/client/locale.ts";

const cleanups: Array<() => void> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});
function translate(dictionary: object) {
  return ((key: string, values: Record<string, unknown> = {}) => {
    let text = (dictionary as Record<string, string>)[key] ?? key;
    for (const [name, value] of Object.entries(values))
      text = text.replace(`{${name}}`, String(value));
    return text;
  }) as ComponentProps<typeof ComposerAttachments>["t"];
}
async function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => root.render(element));
  return { container, render: async (next: ReactElement) => act(async () => root.render(next)) };
}

it.each([
  [en, "Retry"],
  [zh, "重试"],
] as const)(
  "image thumbnail overlays progress or localized retry and clears the overlay when ready",
  async (dictionary, retryLabel) => {
    const retry = vi.fn(),
      remove = vi.fn();
    const props = {
      attachments: [
        {
          kind: "image",
          id: "image",
          file: new File(["bytes"], "photo.png", { type: "image/png" }),
          previewUrl: "blob:photo",
        },
      ],
      uploads: { image: { status: "uploading", loaded: 25, total: 100 } },
      canAcceptDrop: false,
      onAddFiles: vi.fn(),
      onRetryFile: retry,
      onRemoveAttachment: remove,
      t: translate(dictionary),
    } as unknown as ComponentProps<typeof ComposerAttachments>;
    const { container, render } = await mount(createElement(ComposerAttachments, props));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("25%");
    expect(container.querySelector("img")?.src).toBe("blob:photo");
    await render(
      createElement(ComposerAttachments, {
        ...props,
        uploads: { image: { status: "ready" } as never },
      }),
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector("img")?.src).toBe("blob:photo");
    expect(container.textContent).toBe("");
    await render(
      createElement(ComposerAttachments, {
        ...props,
        uploads: { image: { status: "error", message: "offline", transport: true } },
      }),
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    const retryButton = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${dictionary["file.retry"].replace("{name}", "photo.png")}"]`,
    );
    expect(retryButton?.textContent).toBe(retryLabel);
    await act(async () => retryButton!.click());
    expect(retry).toHaveBeenCalledWith("image");
  },
);

it.each([
  [chatEn, "Uploading 25%", "Uploading…"],
  [chatZh, "上传中 25%", "上传中…"],
] as const)(
  "pending images and files update independent progress observers and remove progress when ready",
  async (dictionary, percent, unknown) => {
    const image = createSnapshotStore({ status: "uploading", loaded: 25, total: 100 });
    const file = createSnapshotStore<{ status: string; loaded?: number; total?: number }>({
      status: "uploading",
      loaded: 12,
    });
    const props = {
      submission: {
        requestId: "request",
        placement: "transcript",
        time: 1,
        text: "hello",
        attachments: [
          { type: "image", value: { previewUrl: "blob:photo", name: "photo.png" }, upload: image },
          {
            type: "file",
            value: { attachmentId: "file", name: "notes.txt", bytes: 12 },
            upload: file,
          },
        ],
      },
      renderMessageImages: () => createElement("img", { src: "blob:photo", alt: "photo" }),
      t: translate(dictionary),
    } as unknown as ComponentProps<typeof PendingSubmissionBubble>;
    const { container } = await mount(createElement(PendingSubmissionBubble, props));
    expect(container.textContent).toContain(percent);
    expect(container.textContent).toContain(unknown);
    expect(container.querySelectorAll("[data-upload-progress]")).toHaveLength(2);
    await act(async () => {
      image.set({ status: "ready", loaded: 100, total: 100 });
      file.set({ status: "ready" });
    });
    expect(container.querySelectorAll("[data-upload-progress]")).toHaveLength(0);
    expect(container.textContent).toContain("hello");
  },
);
