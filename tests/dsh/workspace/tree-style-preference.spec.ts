// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import type { SettingsNamespaceView } from "@deepseek-ai/dsh-api-remotes/client";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserPreferences } from "../../../apps/web-ui/packages/client/ui-settings/src/client/browser-preferences.ts";
import { SettingsSchemaService } from "../../../apps/web-ui/packages/client/ui-settings/src/client/schema.ts";
import {
  hasExplicitTreeStyle,
  workspacePreferenceDefaults,
  workspacePreferenceSchema,
  WORKSPACE_PREFERENCES_NAMESPACE,
} from "../../../apps/web-ui/packages/client/ui-workspace/src/client/workspace-preferences.ts";
import { threadActivityPriority } from "../../../apps/web-ui/packages/client/ui-workspace/src/client/rows/thread-tree-presentation.ts";

const contexts: Context[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
});
function fixture() {
  const ctx = new Context();
  contexts.push(ctx);
  const storage = new BrowserPreferences(
    WORKSPACE_PREFERENCES_NAMESPACE,
    new SettingsSchemaService(ctx),
  );
  const view: SettingsNamespaceView = {
    ns: WORKSPACE_PREFERENCES_NAMESPACE,
    autoGenerate: false,
    applies: "live",
    secrets: [],
    schema: workspacePreferenceSchema.toJSON(),
    base: { ...workspacePreferenceDefaults },
    user: {},
    value: { ...workspacePreferenceDefaults },
    revision: 0,
  };
  return { storage, view };
}
it("keeps existing tab preferences and distinguishes an explicit default style from an inherited one", () => {
  const { storage, view } = fixture();
  localStorage.setItem(
    storage.key,
    JSON.stringify({ user: { showRecentVisits: false, tabIdleTimeoutMinutes: 30 }, revision: 2 }),
  );
  expect(storage.read(view).value).toEqual({
    showRecentVisits: false,
    tabIdleTimeoutMinutes: 30,
    threadTreeCollapseStyle: "summary",
  });
  expect(hasExplicitTreeStyle(storage.read(view).user)).toBe(false);
  expect(
    storage.write(view, [{ op: "set", path: ["threadTreeCollapseStyle"], value: "summary" }]),
  ).toBe(true);
  expect(hasExplicitTreeStyle(storage.read(view).user)).toBe(true);
  expect(storage.read(view).user).toEqual({
    showRecentVisits: false,
    tabIdleTimeoutMinutes: 30,
    threadTreeCollapseStyle: "summary",
  });
  expect(
    storage.write(view, [{ op: "set", path: ["threadTreeCollapseStyle"], value: "ring" }]),
  ).toBe(true);
  expect(fixture().storage.read(view).value).toMatchObject({
    threadTreeCollapseStyle: "ring",
    showRecentVisits: false,
  });
  expect(storage.write(view, [{ op: "unset", path: ["threadTreeCollapseStyle"] }])).toBe(true);
  expect(hasExplicitTreeStyle(storage.read(view).user)).toBe(false);
});
it("rejects invalid styles and leaves the prompt eligible after a failed save", () => {
  const { storage, view } = fixture();
  expect(
    storage.write(view, [{ op: "set", path: ["threadTreeCollapseStyle"], value: "unknown" }]),
  ).toBe(false);
  storage.read(view);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  expect(
    storage.write(view, [{ op: "set", path: ["threadTreeCollapseStyle"], value: "ring" }]),
  ).toBe(false);
  expect(hasExplicitTreeStyle(storage.read(view).user)).toBe(false);
  expect(storage.read(view).value).toMatchObject({ threadTreeCollapseStyle: "summary" });
});
it.each([
  [{ pendingInteraction: 1, running: 2, completed: 3 }, "pending"],
  [{ pendingInteraction: 0, running: 2, completed: 3 }, "running"],
  [{ pendingInteraction: 0, running: 0, completed: 3 }, "completed"],
  [{ pendingInteraction: 0, running: 0, completed: 0 }, "idle"],
] as const)("uses one highest-priority descendant state (%j)", (activity, state) => {
  expect(threadActivityPriority(activity)).toBe(state);
});
