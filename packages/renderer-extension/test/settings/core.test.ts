import { describe, expect, it, vi } from "vitest";

import {
  RendererSettingsNavigationState,
  RendererSettingsPageScope,
  createRendererSettingsPageRegistry,
  type RendererSettingsPageDefinition,
} from "../../src/settings/core.js";

function page(
  id: string,
  label = id,
  icon: RendererSettingsPageDefinition["icon"] = "overview",
): RendererSettingsPageDefinition {
  return { id, label, icon, mount: () => undefined };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Renderer settings page registry", () => {
  it("normalizes labels, freezes deterministic pages, and navigates from the default", () => {
    const registry = createRendererSettingsPageRegistry([
      page("overview", "  Overview  "),
      page("local-models", "Local Models", "local-models"),
    ]);
    const navigation = new RendererSettingsNavigationState(registry);

    expect(registry.pages.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "overview", label: "Overview" },
      { id: "local-models", label: "Local Models" },
    ]);
    expect(Object.isFrozen(registry.pages)).toBe(true);
    expect(Object.isFrozen(registry.pages[0])).toBe(true);
    expect(navigation.activePageId).toBe("overview");
    expect(navigation.select("local-models")).toBe(true);
    expect(navigation.select("local-models")).toBe(false);
    expect(navigation.reset()).toBe(true);
  });

  it.each([
    { pages: [] as RendererSettingsPageDefinition[], error: "cannot be empty" },
    { pages: [page("Overview")], error: "Invalid settings page ID" },
    { pages: [page("bad id")], error: "Invalid settings page ID" },
    { pages: [page("overview", " ")], error: "Invalid settings page label" },
    { pages: [page("overview"), page("overview")], error: "Duplicate settings page ID" },
  ])("rejects an invalid registry: $error", ({ pages, error }) => {
    expect(() => createRendererSettingsPageRegistry(pages)).toThrow(error);
  });

  it("rejects a missing default and unknown navigation", () => {
    const registry = createRendererSettingsPageRegistry(
      [page("routes", "Routes", "routes")],
      "routes",
    );
    const navigation = new RendererSettingsNavigationState(registry);
    expect(() => createRendererSettingsPageRegistry([page("routes")])).toThrow(
      "Default settings page is not registered",
    );
    expect(() => navigation.select("providers")).toThrow("Unknown settings page");
  });
});

describe("Renderer settings page async scope", () => {
  it("applies only the latest request result and aborts the older request", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const success = vi.fn();
    const failure = vi.fn();
    const signals: AbortSignal[] = [];
    const scope = new RendererSettingsPageScope();

    const firstRun = scope.runLatest(
      (signal) => {
        signals.push(signal);
        return first.promise;
      },
      { success, failure },
    );
    const secondRun = scope.runLatest(
      (signal) => {
        signals.push(signal);
        return second.promise;
      },
      { success, failure },
    );
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    first.resolve("stale");
    second.resolve("current");
    await Promise.all([firstRun, secondRun]);
    expect(success).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith("current");
    expect(failure).not.toHaveBeenCalled();
  });

  it("reports only a current failure", async () => {
    const failure = vi.fn();
    const scope = new RendererSettingsPageScope();
    await scope.runLatest(() => Promise.reject(new Error("unavailable")), {
      success: vi.fn(),
      failure,
    });
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("aborts and ignores a late result after disposal", async () => {
    const pending = deferred<string>();
    const success = vi.fn();
    const failure = vi.fn();
    const scope = new RendererSettingsPageScope();
    let operationSignal: AbortSignal | undefined;
    const run = scope.runLatest(
      (signal) => {
        operationSignal = signal;
        return pending.promise;
      },
      { success, failure },
    );

    scope.dispose();
    expect(scope.signal.aborted).toBe(true);
    expect(operationSignal?.aborted).toBe(true);
    pending.resolve("late");
    await run;
    expect(success).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    await expect(
      scope.runLatest(() => Promise.resolve("no"), { success, failure }),
    ).rejects.toThrow("Settings page scope is disposed");
  });
});
