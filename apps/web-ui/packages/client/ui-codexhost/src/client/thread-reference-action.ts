/** Product eligibility for the phone sidebar's explicit draft-reference action. */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  ReferenceSessionMenuItem,
  type ReferenceSessionInjected,
  type SessionDraftReference,
} from "@deepseek-ai/dsh-client-ui-workspace/client";
import {
  threadReferenceInsert,
  threadReferenceOf,
} from "@deepseek-ai/dsh-client-ui-conversation/thread-reference";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";

export function registerThreadReferenceAction(ctx: Context): void {
  const t = ctx.locale.bind("codexhostImport");
  const current = () => {
    if (ctx.layout.panelInfo.getSnapshot().activePanelId !== null) return;
    return ctx.uiSession.adapter.current.getSnapshot().key as SessionId | undefined;
  };
  const prepareDraftReference = (sourceId: SessionId): SessionDraftReference | undefined => {
    const targetId = current();
    if (targetId === undefined || sourceId === targetId) return;
    const binding = ctx.sessions.binding(targetId);
    if (binding === undefined) return;
    const reference = () => {
      const list = ctx.sessions.list.getSnapshot();
      const row = list.byId[sourceId];
      if (
        row === undefined ||
        row.id !== sourceId ||
        ctx.sessions.binding(sourceId)?.session.getSnapshot().removed === true ||
        ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(sourceId)
      )
        return;
      return threadReferenceOf(row);
    };
    if (reference() === undefined) return;
    const insertion = ctx.conversation.input.captureReferenceInsertion(binding);
    if (insertion === undefined) return;
    const input = ctx.conversation.input.for(binding.ctx);
    let expired = false;
    const available = (): boolean => {
      if (
        current() !== targetId ||
        ctx.sessions.binding(targetId) !== binding ||
        ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(targetId) ||
        reference() === undefined
      )
        expired = true;
      return !expired && insertion.getSnapshot();
    };
    return {
      getSnapshot: available,
      subscribe: (listener) => {
        // Latch invalidation at the event, even if A -> C -> A happens before React renders.
        const changed = () => {
          available();
          listener();
        };
        const off = [
          ctx.sessions.list.subscribe(changed),
          ctx.uiSession.adapter.current.subscribe(changed),
          ctx.workspaces.list.subscribe(changed),
          ctx.layout.panelInfo.subscribe(changed),
          insertion.subscribe(changed),
        ];
        return () => off.forEach((dispose) => dispose());
      },
      insert: () => {
        const allowed = available();
        expired = true;
        const source = reference();
        if (!allowed || source === undefined) return false;
        if (!insertion.insert(threadReferenceInsert(source))) return false;
        input.notify("info", t("reference.addedToDraft"));
        return true;
      },
    };
  };
  ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
    ctx.slots.register(
      {
        name: "sidebar.workspaces.session.menu.item",
        id: "codexhost.reference-current-draft",
        order: 360,
        locale: "workspace",
        inject: (): ReferenceSessionInjected => ({ prepareDraftReference }),
      },
      ReferenceSessionMenuItem,
    ),
  );
}
