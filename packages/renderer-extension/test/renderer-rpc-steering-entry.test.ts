import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/install-renderer-binding.js", () => ({ installRendererBinding: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("publishes the installed forHost, so a healthy wrapper is never treated as displaced", async () => {
  const fakeWindow = {
    __codexhostHostRoutingV1: { dispose: vi.fn() },
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as Window & typeof globalThis & Record<string, never>;
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("document", { documentElement: {}, body: {} });
  vi.stubGlobal(
    "CustomEvent",
    class {
      constructor(readonly type: string) {}
    },
  );
  await import("../src/production-entry.js");
  const native = () => ({});
  const controller = { forHost: native };
  const state = fakeWindow as unknown as {
    __codexhostInstallRpcSteeringV1(value: unknown): boolean;
    __codexhostRpcSteeringV1?: { controller: unknown; forHost: unknown; release(): void };
  };

  expect(state.__codexhostInstallRpcSteeringV1(controller)).toBe(true);
  const marker = state.__codexhostRpcSteeringV1;
  expect(marker?.controller).toBe(controller);
  expect(controller.forHost).not.toBe(native);
  expect(marker?.forHost).toBe(controller.forHost);

  marker?.release();
  expect(state.__codexhostRpcSteeringV1).toBeUndefined();
  expect(controller.forHost).toBe(native);
});
