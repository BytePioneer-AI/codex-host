import assert from "node:assert/strict";
import { it } from "node:test";
import type { Inspection } from "../src/harnesses.ts";
import { nativePermissionView } from "../src/session-presentation.ts";

const ready: Extract<Inspection, { status: "ready" }> = {
  status: "ready",
  catalog: { models: [], thinkingOptions: [] },
  permissionModes: {
    modes: [
      { id: "auto", label: "Native Auto", description: "Native classifier", dangerous: true },
    ],
    defaultModeId: "auto",
  },
  capabilities: {
    configuration: { selectModel: false, selectThinkingOption: false, selectPermissionMode: true },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  },
};
it("preserves native labels, descriptions and danger flags, not DSH auto semantics", () => {
  const view = nativePermissionView("harness", ready, true);
  assert.equal(view.catalog, ready.permissionModes);
  assert.equal(view.locked, false);
  assert.equal(view.catalog?.modes[0]?.label, "Native Auto");
});
it("does not invent default permission controls for unsupported or unavailable Harnesses", () => {
  for (const inspection of [
    {
      ...ready,
      permissionModes: undefined,
      capabilities: {
        ...ready.capabilities,
        configuration: { ...ready.capabilities.configuration, selectPermissionMode: false },
      },
    },
    { status: "unavailable", error: { message: "Unavailable" } },
  ] as Inspection[]) {
    const view = nativePermissionView("harness", inspection, false);
    assert.equal(view.selectable, false);
    assert.equal(view.catalog, null);
  }
});
it("creation scope and live session capability changes remain authoritative", () => {
  assert.equal(
    nativePermissionView("harness", ready, false, {
      selectPermissionMode: true,
      permissionModeScope: "atCreate",
    }).locked,
    false,
  );
  assert.equal(
    nativePermissionView("harness", ready, true, {
      selectPermissionMode: true,
      permissionModeScope: "atCreate",
    }).locked,
    true,
  );
  assert.equal(
    nativePermissionView("harness", ready, true, { selectPermissionMode: false }).selectable,
    false,
  );
});
