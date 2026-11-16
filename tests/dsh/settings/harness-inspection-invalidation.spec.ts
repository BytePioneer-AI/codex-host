// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { afterEach, expect, it, vi } from "vitest";
import { ModelDirectoryResolver } from "../../../apps/web-ui/packages/client/ui-model-selection/src/client/service.ts";

vi.mock(
  "../../../apps/web-ui/packages/client/ui-model-selection/src/client/preferences-api.ts",
  () => ({
    preferenceCall: async () => {
      throw new Error("No legacy preferences");
    },
  }),
);

const contexts: Context[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
});
const response = (model: string) => ({
  ok: true as const,
  value: { default: { provider: "fake", model }, groups: [], routableProviders: [] },
});
function fixture(modelCatalog: ReturnType<typeof vi.fn>) {
  const ctx = new Context();
  contexts.push(ctx);
  const handlers = new Map<string, () => void>();
  const remoteSession = { modelCatalog };
  ctx.provide("remote", {
    session: remoteSession,
    $on: (name: string, listener: () => void) => handlers.set(name, listener),
  } as never);
  ctx.provide("remote.session", remoteSession as never);
  const projected = createSnapshotStore({});
  const binding = {
    session: {
      projections: { faceOf: () => projected },
      getSnapshot: () => ({ blank: true }),
    },
  };
  ctx.provide("sessions", {
    scope: () => ctx,
    binding: () => binding,
    subagentAddress: () => undefined,
  } as never);
  const resolver = new ModelDirectoryResolver(ctx);
  const invalidate = () => {
    const listener = handlers.get("codexhost/harness-inspection-changed");
    expect(listener).toBeDefined();
    listener?.();
  };
  return { resolver, invalidate };
}

it("refreshes only the local selector catalog, leaving remote Host directories untouched", async () => {
  const modelCatalog = vi.fn(async () => response("first"));
  const { resolver, invalidate } = fixture(modelCatalog);
  const remote = resolver.directoryFor("web-remote:office" as SessionId);
  await remote.load();
  await vi.waitFor(() => expect(resolver.harnessCatalog.getSnapshot().status).toBe("ready"));
  expect(modelCatalog.mock.calls).toEqual([[undefined], [{ sessionId: "web-remote:office" }]]);
  modelCatalog.mockClear();
  modelCatalog.mockResolvedValue(response("changed"));
  invalidate();
  await vi.waitFor(() =>
    expect(resolver.harnessCatalog.getSnapshot().value?.default.model).toBe("changed"),
  );
  expect(modelCatalog.mock.calls).toEqual([[undefined]]);
  await remote.load();
  expect(modelCatalog).toHaveBeenCalledTimes(1);
});

it("uses the existing catalog refresh coalescing and ignores a late pre-refresh result", async () => {
  const old = Promise.withResolvers<ReturnType<typeof response>>();
  const latest = Promise.withResolvers<ReturnType<typeof response>>();
  const modelCatalog = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  const { resolver, invalidate } = fixture(modelCatalog);
  invalidate();
  invalidate();
  invalidate();
  expect(modelCatalog).toHaveBeenCalledTimes(1);
  old.resolve(response("stale"));
  await vi.waitFor(() => expect(modelCatalog).toHaveBeenCalledTimes(2));
  expect(resolver.harnessCatalog.getSnapshot().value).toBeNull();
  latest.resolve(response("latest"));
  await vi.waitFor(() =>
    expect(resolver.harnessCatalog.getSnapshot().value?.default.model).toBe("latest"),
  );
  expect(modelCatalog).toHaveBeenCalledTimes(2);
});
