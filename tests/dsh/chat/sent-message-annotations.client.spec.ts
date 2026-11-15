// @vitest-environment jsdom
import { act, createElement } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { composeAnnotatedMessage } from "@codexhost/shared-contracts";
import {
  UserMessageNodeView,
  SentMessageRecovery,
} from "../../../apps/web-ui/packages/client/ui-chat/src/client/chat/MessageItem.tsx";
import { useSentMessageEditing } from "../../../apps/web-ui/packages/client/ui-chat/src/client/chat/SentMessageEditor.tsx";
import type {
  ChatViewInjected,
  SentMessageEditing,
} from "../../../apps/web-ui/packages/client/ui-chat/src/client/contract/slots.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

function mount(annotations: { text: string; annotation?: string }[], body = "original") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const send = vi.fn<NonNullable<ChatViewInjected["editMessage"]>>(async () => ({
    status: "accepted",
  }));
  let editing: SentMessageEditing;
  let recovery = false;
  const t: ComponentProps<typeof SentMessageRecovery>["t"] = (key) => key;
  function View() {
    editing = useSentMessageEditing(send, 7, false);
    if (recovery)
      return createElement(SentMessageRecovery, { editing, renderMessageImages: () => null, t });
    const props: Partial<ComponentProps<typeof UserMessageNodeView>> = {
      node: {
        key: "user:7",
        id: "7",
        target: "chat",
        kind: "user",
        anchorSeq: 7,
        visibility: "visible",
        location: { kind: "session" },
        data: {
          kind: "user",
          seq: 7,
          time: 0,
          source: null,
          content: [{ type: "text", text: composeAnnotatedMessage(annotations, body) }],
          responseAnnotations: annotations,
        },
      },
      messageEditing: editing,
      renderMessageImages: () => null,
      useProjection: (() => undefined) as ComponentProps<
        typeof UserMessageNodeView
      >["useProjection"],
      t,
    };
    return createElement(UserMessageNodeView, props as ComponentProps<typeof UserMessageNodeView>);
  }
  act(() => root.render(createElement(View)));
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="message.edit"]');
  expect(button).not.toBeNull();
  act(() => button!.click());
  return {
    host,
    send,
    get editing() {
      return editing!;
    },
    recover() {
      recovery = true;
      act(() => root.render(createElement(View)));
    },
  };
}

it.each(["updated", ""])("retains annotations when editing the body to %j", async (body) => {
  const annotations = [{ text: "quoted reply", annotation: "keep this comment" }];
  const view = mount(annotations);
  expect(view.host.querySelector("textarea")?.value).toBe("original");
  expect(view.editing.draft?.responseAnnotations).toEqual(annotations);
  act(() => view.editing.change(body));
  expect(view.host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  await act(async () => view.editing.send());
  expect(view.send).toHaveBeenCalledWith(7, composeAnnotatedMessage(annotations, body));
  expect(view.editing.draft).toBeNull();
});

it("allows editing an annotation-only message without adding body text", async () => {
  const annotations = [{ text: "quoted reply" }];
  const view = mount(annotations, "");
  await act(async () => view.editing.send());
  expect(view.send).toHaveBeenCalledWith(7, composeAnnotatedMessage(annotations, ""));
});

it("preserves annotations in recovery and after a rejected edit", async () => {
  const annotations = [{ text: "quoted reply" }];
  const view = mount(annotations);
  view.send.mockResolvedValueOnce({ status: "rejected", message: "retry" });
  view.recover();
  expect(view.host.querySelector("[data-message-annotations]")?.textContent).toContain(
    "quoted reply",
  );
  await act(async () => view.editing.send());
  expect(view.editing.draft?.responseAnnotations).toEqual(annotations);
  expect(view.editing.draft?.text).toBe("original");
  await act(async () => view.editing.send());
  expect(view.send).toHaveBeenLastCalledWith(7, composeAnnotatedMessage(annotations, "original"));
});

it("still refuses an empty unannotated edit", async () => {
  const view = mount([]);
  act(() => view.editing.change("   "));
  expect(view.host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  await act(async () => view.editing.send());
  expect(view.send).not.toHaveBeenCalled();
});
