// @vitest-environment jsdom
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { ConversationContent } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx";
import type { ConversationContentProps } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/contract/slots.ts";
import { SessionOpeningNotice } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/SessionOpeningNotice.tsx";

function renderContent(openState: "loading" | "open" | "error", blocked = false) {
  const composer = vi.fn();
  const props = {
    sessionId: "target",
    phase: "active",
    hero: false,
    useSession: (select: (s: unknown) => unknown) => select({ sessionId: "target", openState }),
    useSessions: (select: (s: unknown) => unknown) =>
      select({ phase: "pending", ids: ["target"], byId: { target: { cwd: "/project" } } }),
    useSessionStatus: (select: (s: unknown) => unknown) => select(new Map()),
    useWorkspaces: (select: (s: unknown) => unknown) =>
      select({ phase: "pending", items: [], canStartProjectless: true }),
    useInput: (select: (s: unknown) => unknown) => select({}),
    useComposerBlock: (select: (s: unknown) => unknown) =>
      select(blocked ? { reason: "configuration unavailable" } : undefined),
    useFactorySlot: (name: string, fallback: unknown) =>
      name === "views"
        ? () => createElement("p", { "data-history": "" }, "recent history")
        : fallback,
    renderSlot: (name: string, owner: unknown) => {
      if (name === "conversation.composer.bar") composer(owner);
      return null;
    },
    renderSlotChain: (_name: string, _owner: unknown, options: { fallback: unknown }) =>
      options.fallback,
    t: (key: string) => key,
  } as unknown as ConversationContentProps;
  const html = renderToStaticMarkup(createElement(ConversationContent, props));
  return { html, owner: composer.mock.calls.at(-1)?.[0] };
}

it("keeps recent history visible while projects/sidebar are pending or a composer dependency fails", () => {
  const ready = renderContent("open");
  expect(ready.html).toContain("recent history");
  expect(ready.owner.disabled).toBeUndefined();
  const blocked = renderContent("open", true);
  expect(blocked.html).toContain("recent history");
  expect(blocked.owner.blocked).toEqual({ reason: "configuration unavailable" });
});

it.each(["loading", "error"] as const)(
  "does not advertise a sendable composer while session history is %s",
  (state) => {
    const content = renderContent(state);
    expect(content.html).toContain("recent history");
    expect(content.owner.disabled).toBe(true);
  },
);

it("renders a local lookup error and retry, then clears the notice independently", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const opening = createSnapshotStore({
    state: "error" as const,
    sessionId: "target",
    message: "lookup failed",
  });
  const retryOpening = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(SessionOpeningNotice, {
          navigation: { opening, retryOpening } as never,
          t: ((key: string) => key) as never,
        }),
      ),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("lookup failed");
    await act(async () => container.querySelector("button")!.click());
    expect(retryOpening).toHaveBeenCalledOnce();
    await act(async () => opening.set({ state: "idle" } as never));
    expect(container.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
