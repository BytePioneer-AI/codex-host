// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import { ClientSessions } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/service.ts";
import type { SessionRemotes } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/remotes.ts";
import type {
  SessionListRequest,
  SessionListValue,
} from "../../../apps/web-ui/packages/api/session-controller/src/types.ts";
import { SessionListError } from "../../../apps/web-ui/packages/client/ui-workspace/src/client/rows/SessionListError.tsx";
import { en, zh } from "../../../apps/web-ui/packages/client/ui-workspace/src/client/locales.ts";

const current = SessionId("current");
const older = SessionId("older");
const summary = (sessionId: SessionId) => ({
  sessionId,
  blank: false,
  running: false,
  agentAvailable: true,
  updatedAt: 1,
});
const success = (
  items = [summary(current)],
  nextCursor: string | null = null,
): RemoteResult<SessionListValue> => ({
  ok: true,
  value: { items, nextCursor },
});
const failure = {
  ok: false,
  error: { code: "test/offline", message: "Sidebar unavailable" },
} as RemoteResult<SessionListValue>;

it.each([
  ["initial", "Retry", en],
  ["initial", "重试", zh],
  ["head", "Retry", en],
  ["more", "Retry", en],
] as const)(
  "retries only the failed %s list page through the localized %s button",
  async (page, label, dictionary) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const ctx = new Context();
    const list = vi.fn<(request: SessionListRequest) => Promise<RemoteResult<SessionListValue>>>(
      async () => success(),
    );
    const follow = vi.fn();
    const sessions = new ClientSessions(ctx, {
      session: { list, follow },
    } as unknown as SessionRemotes);
    const retain = vi.spyOn(sessions, "retain");
    // A direct-link row can already be displayed while the initial sidebar page is unavailable.
    sessions.handleSessionAdded(summary(current));
    if (page !== "initial") {
      list.mockResolvedValueOnce(success([summary(current)], "20"));
      await sessions.refresh();
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Region() {
      const state = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot);
      return createElement(
        "div",
        null,
        createElement("p", { "data-loaded": "" }, state.ids.join(",")),
        createElement(SessionListError, {
          list: state,
          refreshSessions: () => {
            void sessions.refresh();
          },
          loadMoreSessions: () => {
            void sessions.loadMore();
          },
          t: (key) => dictionary[key],
        }),
      );
    }
    try {
      await act(async () => root.render(createElement(Region)));
      const loaded = container.querySelector("[data-loaded]");
      list.mockResolvedValueOnce(failure);
      await act(async () => {
        await (page === "more" ? sessions.loadMore() : sessions.refresh());
      });
      expect(sessions.list.getSnapshot()).toMatchObject({
        listError: "Sidebar unavailable",
        listErrorPage: page === "more" ? "more" : "head",
        hasMore: page !== "initial",
        ids: [current],
      });
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Sidebar unavailable");
      const retry = alert?.querySelector("button");
      expect(retry?.textContent).toBe(label);
      expect(retry?.disabled).toBe(false);
      const next = Promise.withResolvers<RemoteResult<SessionListValue>>();
      list.mockReturnValueOnce(next.promise);
      const calls = list.mock.calls.length;
      await act(async () => retry?.click());
      expect(list).toHaveBeenCalledTimes(calls + 1);
      expect(list).toHaveBeenLastCalledWith(
        page === "more" ? { includeArchived: false, cursor: "20" } : { includeArchived: false },
      );
      expect(sessions.list.getSnapshot().loading).toBe(true);
      expect(sessions.list.getSnapshot().ids).toEqual([current]);
      expect(container.querySelector("[data-loaded]")).toBe(loaded);
      expect(loaded?.textContent).toBe(current);
      await act(async () => {
        next.resolve(page === "more" ? success([summary(older)]) : success());
        await next.promise;
      });
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(new Set(sessions.list.getSnapshot().ids)).toEqual(
        new Set(page === "more" ? [current, older] : [current]),
      );
      expect(retain).not.toHaveBeenCalled();
      expect(follow).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      await ctx.fiber.dispose();
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);
