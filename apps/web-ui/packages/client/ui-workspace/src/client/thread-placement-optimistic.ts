/** Pending display placements overlay the catalog until an acknowledged parent arrives. */
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { threadInsertOrder } from "./thread-tree-order.ts";

export type PlacementOrder = {
  account: string;
  base: readonly SessionId[];
  anchor?: SessionId | undefined;
  half: "before" | "after";
};
export type OptimisticPlacement = {
  token: number;
  id: SessionId;
  parent: SessionId | null;
  order?: PlacementOrder | undefined;
  acknowledged: boolean;
};
export type PlacementOrders = Readonly<Record<string, readonly string[]>>;

export function applyPlacementOrder(orders: PlacementOrders, order: PlacementOrder, id: SessionId) {
  const saved = (orders[order.account] ?? order.base).map(SessionId);
  const members = [...order.base.filter((member) => !saved.includes(member)), ...saved];
  return threadInsertOrder(members, id, order.anchor, order.half);
}

export function applyPlacementOrders(
  orders: Record<string, string[]>,
  pending: readonly OptimisticPlacement[],
): Record<string, string[]> {
  if (!pending.some((operation) => operation.order)) return orders;
  const result = { ...orders };
  for (const operation of pending)
    if (operation.order)
      result[operation.order.account] = applyPlacementOrder(result, operation.order, operation.id);
  return result;
}

export function applyPlacements(
  list: SessionListState,
  pending: readonly OptimisticPlacement[],
): SessionListState {
  if (pending.length === 0) return list;
  const byId = { ...list.byId };
  for (const { id, parent } of pending) {
    const row = byId[id];
    if (row)
      byId[id] = {
        ...row,
        projectionValues: { ...row.projectionValues, threadTreeParent: parent },
      };
  }
  return { ...list, byId };
}

/** A response alone cannot clear an overlay; unrelated/stale catalog pushes leave it intact. */
export function confirmPlacements(
  pending: readonly OptimisticPlacement[],
  list: SessionListState,
): readonly OptimisticPlacement[] {
  const confirmed = new Map<SessionId, number>();
  for (const operation of pending) {
    if (
      operation.acknowledged &&
      list.byId[operation.id]?.projectionValues?.threadTreeParent === operation.parent
    )
      confirmed.set(operation.id, operation.token);
  }
  const next = pending.filter(
    (operation) => !operation.acknowledged || operation.token > (confirmed.get(operation.id) ?? -1),
  );
  return next.length === pending.length ? pending : next;
}

/** Only this operation is removed on failure; newer gestures retain their own intent. */
export function settlePlacement(
  pending: readonly OptimisticPlacement[],
  token: number,
  ok: boolean,
): readonly OptimisticPlacement[] {
  return ok
    ? pending.map((operation) =>
        operation.token === token ? { ...operation, acknowledged: true } : operation,
      )
    : pending.filter((operation) => operation.token !== token);
}
