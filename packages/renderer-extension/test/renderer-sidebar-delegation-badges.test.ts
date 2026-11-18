// @vitest-environment jsdom
import {
  harnessIdSchema,
  hostThreadIdSchema,
  type DelegationChild,
  type DelegationChildrenParams,
  type DelegationChildrenResult,
} from "@codexhost/shared-contracts";
import { afterEach, expect, it } from "vitest";

import type { RendererModelClient } from "../src/renderer-model-client.js";
import { installRendererSidebarDelegationBadges } from "../src/renderer-sidebar-delegation-badges.js";

const POPOVER = "[data-codexhost-delegation-popover]";
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function child(id: string, status: DelegationChild["status"]): DelegationChild {
  return {
    threadId: hostThreadIdSchema.parse(id),
    harnessId: harnessIdSchema.parse("pi"),
    status,
    title: `${id} title`,
  };
}

/** A native Codex child, whose title the Host reads only for an open list. */
function codexChild(id: string, status: DelegationChild["status"]): DelegationChild {
  return {
    threadId: hostThreadIdSchema.parse(id),
    harnessId: harnessIdSchema.parse("codex"),
    status,
  };
}

/** A local sidebar row as Desktop renders it, with the Agent icon codexhost already decorates. */
function sidebarRow(sidebar: HTMLElement, threadId: string): HTMLElement {
  const row = document.createElement("div");
  const attributes = {
    "data-app-action-sidebar-thread-row": threadId,
    "data-app-action-sidebar-thread-id": threadId,
    "data-app-action-sidebar-thread-host-id": "local",
  };
  for (const [name, value] of Object.entries(attributes)) row.setAttribute(name, value);
  Object.defineProperty(row, "__reactFiber$test", {
    value: { memoizedProps: { conversationId: threadId, dataAttributes: attributes } },
  });
  const icon = document.createElement("span");
  icon.setAttribute("data-codexhost-sidebar-agent-icon", "pi");
  row.append(icon);
  sidebar.append(row);
  return icon;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const settle = () => new Promise((done) => setTimeout(done, 30));

function install(state: Map<string, DelegationChild[]>) {
  const opens: {
    params: DelegationChildrenParams;
    reply: ReturnType<typeof deferred<DelegationChildrenResult>>;
  }[] = [];
  const answer = (params: DelegationChildrenParams): DelegationChildrenResult => ({
    parents: params.threadIds.map((threadId) => ({
      threadId,
      children: (state.get(threadId) ?? []).map((entry) =>
        params.includeTitles
          ? { ...entry, title: entry.title ?? `${entry.threadId} title` }
          : entry,
      ),
    })),
  });
  const client = {
    async listDelegationChildren(params: DelegationChildrenParams) {
      if (!params.includeTitles) return answer(params);
      const reply = deferred<DelegationChildrenResult>();
      opens.push({ params, reply });
      return reply.promise;
    },
  } as unknown as RendererModelClient;
  const sidebar = document.createElement("aside");
  sidebar.setAttribute("data-app-action-sidebar-scroll", "");
  document.body.append(sidebar);
  const icons = { a: sidebarRow(sidebar, "parent-a"), b: sidebarRow(sidebar, "parent-b") };
  const badges = installRendererSidebarDelegationBadges({
    getClient: () => client,
    openThread: async () => undefined,
  });
  disposers.push(() => badges.dispose());
  /** Answers the `index`-th title request, with the state at that moment. */
  const respond = (index: number): void => {
    const open = opens[index];
    if (!open) throw new Error(`no title request ${index}`);
    open.reply.resolve(answer(open.params));
  };
  return { icons, respond };
}

const popoverText = () => document.querySelector(POPOVER)?.textContent;

it("opens the list at once and fills native titles only into the list still open", async () => {
  const state = new Map([
    ["parent-a", [codexChild("child-a", "running")]],
    ["parent-b", [codexChild("child-b", "running")]],
  ]);
  const { icons, respond } = install(state);
  await settle();

  icons.a.click();
  expect(popoverText()).toContain("运行中");
  icons.b.click();
  respond(0);
  await settle();
  expect(document.querySelectorAll(POPOVER)).toHaveLength(1);
  expect(popoverText()).not.toContain("child-a title");

  respond(1);
  await settle();
  expect(popoverText()).toContain("child-b title");
});

it("moves keyboard focus into the list and back to the icon on Escape", async () => {
  const state = new Map([["parent-b", [child("child-b", "running")]]]);
  const { icons } = install(state);
  await settle();

  icons.b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(document.activeElement?.getAttribute("data-codexhost-delegation-child")).toBe("child-b");
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  expect(document.querySelector(POPOVER)).toBeNull();
  expect(document.activeElement).toBe(icons.b);
});

it("updates an open list with the same poll that updates its badge", async () => {
  const state = new Map([["parent-b", [child("child-b", "running")]]]);
  const { icons } = install(state);
  await settle();

  icons.b.click();
  expect(popoverText()).toContain("运行中");
  const focusChild = () =>
    document.querySelector<HTMLElement>('[data-codexhost-delegation-child="child-b"]')?.focus();
  const focusedChild = () =>
    document.activeElement?.getAttribute("data-codexhost-delegation-child") ?? null;

  focusChild();
  document.dispatchEvent(new Event("visibilitychange"));
  await settle();
  expect(focusedChild()).toBe("child-b");

  state.set("parent-b", [child("child-b", "question")]);
  document.dispatchEvent(new Event("visibilitychange"));
  await settle();

  expect(icons.b.getAttribute("data-codexhost-delegation-badge")).toBe("parent-b:1:question");
  expect(popoverText()).toContain("待回答");
  expect(focusedChild()).toBe("child-b");
});
