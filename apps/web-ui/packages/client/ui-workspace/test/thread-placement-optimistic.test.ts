import assert from "node:assert/strict";
import { it } from "node:test";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import {
  applyPlacements,
  applyPlacementOrders,
  confirmPlacements,
  settlePlacement,
  type OptimisticPlacement,
} from "../src/client/thread-placement-optimistic.ts";

function catalog(parent: string | null = "original"): SessionListState {
  const id = SessionId("child");
  return {
    ids: [id],
    phase: "ready",
    projectionsBySession: {},
    byId: {
      [id]: {
        id,
        title: "child",
        displayTitle: "child",
        updatedAt: 1,
        blank: false,
        running: false,
        retainedBy: {},
        projectionValues: { threadTreeParent: parent },
      },
    },
  };
}
function move(token: number, parent: string | null): OptimisticPlacement {
  return {
    token,
    id: SessionId("child"),
    parent,
    acknowledged: false,
    order: {
      account: `thread:${parent}`,
      base: [SessionId("anchor")],
      anchor: SessionId("anchor"),
      half: "after",
    },
  };
}

it("applies parent and order immediately without mutating the catalog or saved orders", () => {
  const list = catalog(),
    orders = { "thread:target": ["anchor"] },
    pending = [move(1, "target")];
  assert.equal(
    applyPlacements(list, pending).byId[SessionId("child")].projectionValues?.threadTreeParent,
    "target",
  );
  assert.deepEqual(applyPlacementOrders(orders, pending), { "thread:target": ["anchor", "child"] });
  assert.equal(list.byId[SessionId("child")].projectionValues?.threadTreeParent, "original");
  assert.deepEqual(orders, { "thread:target": ["anchor"] });
  assert.equal(applyPlacements(list, []), list);
  assert.equal(applyPlacementOrders(orders, []), orders);
});

it("requires both RPC success and matching catalog parent, including explicit top level", () => {
  const pending = [move(1, null)];
  assert.equal(confirmPlacements(pending, catalog(null)), pending);
  const accepted = settlePlacement(pending, 1, true);
  assert.equal(confirmPlacements(accepted, catalog()), accepted);
  assert.deepEqual(confirmPlacements(accepted, catalog(null)), []);
  assert.deepEqual(confirmPlacements(accepted, { ...catalog(), byId: {} }), accepted);
});

it("an earlier confirmation or failure never removes a newer drag", () => {
  const pending = [move(1, "first"), move(2, "second")];
  for (const ok of [false, true]) {
    const next = confirmPlacements(settlePlacement(pending, 1, ok), catalog("first"));
    assert.equal(
      applyPlacements(catalog("first"), next).byId[SessionId("child")].projectionValues
        ?.threadTreeParent,
      "second",
    );
    assert.deepEqual(next, [pending[1]]);
  }
  const accepted = settlePlacement(settlePlacement(pending, 1, true), 2, true);
  assert.deepEqual(confirmPlacements(accepted, catalog("second")), []);
});

it("rolls back a failed operation only, returning to the last successful parent or original", () => {
  const pending = [move(1, "first"), move(2, "second")];
  const failedSecond = settlePlacement(settlePlacement(pending, 1, true), 2, false);
  assert.equal(
    applyPlacements(catalog(), failedSecond).byId[SessionId("child")].projectionValues
      ?.threadTreeParent,
    "first",
  );
  const failedBoth = settlePlacement(settlePlacement(pending, 1, false), 2, false);
  assert.equal(
    applyPlacements(catalog(), failedBoth).byId[SessionId("child")].projectionValues
      ?.threadTreeParent,
    "original",
  );
  assert.deepEqual(applyPlacementOrders({ "thread:first": ["anchor"] }, failedBoth), {
    "thread:first": ["anchor"],
  });
});

it("replays shared-container ordering without losing another drag on rollback", () => {
  const first = move(1, "target");
  const second = {
    ...move(2, "target"),
    id: SessionId("other"),
    order: { ...first.order!, half: "before" as const },
  };
  const orders = { "thread:target": ["anchor"] };
  assert.deepEqual(applyPlacementOrders(orders, [first, second])["thread:target"], [
    "other",
    "anchor",
    "child",
  ]);
  assert.deepEqual(
    applyPlacementOrders(orders, settlePlacement([first, second], 1, false))["thread:target"],
    ["other", "anchor"],
  );
  assert.deepEqual(
    applyPlacementOrders(orders, settlePlacement([first, second], 2, false))["thread:target"],
    ["anchor", "child"],
  );
});
