import { describe, expect, it, vi } from "vitest";
import {
  loadCodexScheduleServices,
  loadCodexScheduleCreationInputsFactory,
} from "../src/codex-schedule-services.js";
function owner(...urls: string[]): Window {
  return {
    location: { href: "app://-/index.html" },
    document: {
      querySelectorAll: () => urls.map((url) => ({ getAttribute: () => url })),
    },
  } as unknown as Window;
}
function native() {
  return {
    localAutomations: Object.assign(() => {}, {
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      create: vi.fn(),
    }),
  };
}
function factory() {
  return new Function(
    "scope",
    "host",
    `return new NativeReader({scope:scope,hostId:host,requestClient:scope.get(clientAtom,host),dynamicTools:new NativeTools(host,message=>{window.dispatchEvent(new MessageEvent("message",{data:message,origin:window.location.origin,source:window}))})})`,
  );
}
describe("native schedule service discovery", () => {
  it("accepts callable RPC namespaces at arbitrary preloaded chunk/export names", async () => {
    const registry = native(),
      load = vi.fn().mockResolvedValue({ renamed: registry, same: registry });
    expect(await loadCodexScheduleServices(owner("/moved-services.js"), load)).toEqual({
      localAutomations: registry.localAutomations,
      isPrimaryWindow: false,
    });
    expect(load).toHaveBeenCalledExactlyOnceWith("app://-/moved-services.js");
    expect(registry.localAutomations.list).not.toHaveBeenCalled();
  });
  it("uses the primary-window namespace only to mark creation availability", async () => {
    const registry = { ...native(), localAutomationsScheduler: () => {} };
    expect(
      (
        await loadCodexScheduleServices(owner("/app-shared-renamed.js"), async () => ({
          any: registry,
        }))
      )?.isPrimaryWindow,
    ).toBe(true);
  });
  it("rejects inherited or ambiguous owning registries without calling any RPC", async () => {
    const registry = native();
    expect(
      await loadCodexScheduleServices(owner("/a.js"), async () => ({
        inherited: Object.create(registry),
      })),
    ).toBeNull();
    await expect(
      loadCodexScheduleServices(owner("/a.js"), async () => ({
        first: native(),
        second: native(),
      })),
    ).rejects.toThrow("unavailable");
  });
  it("reads a namespace initialized after an earlier page attempt without caching failure", async () => {
    const registry: Record<string, unknown> = {};
    const load = vi.fn(async () => ({ registry }));
    expect(await loadCodexScheduleServices(owner("/a.js"), load)).toBeNull();
    Object.assign(registry, native());
    expect(await loadCodexScheduleServices(owner("/a.js"), load)).not.toBeNull();
  });
  it("does not load foreign or query-bearing module URLs", async () => {
    const load = vi.fn();
    expect(
      await loadCodexScheduleServices(
        owner("https://example.com/a.js", "app://other/a.js", "/a.js?token=hidden", "/a.css"),
        load,
      ),
    ).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
  it("identifies only the reviewed native creation factory with arbitrary identifiers", async () => {
    const readerFactory = factory();
    expect(
      await loadCodexScheduleCreationInputsFactory(owner("/relocated.js"), async () => ({
        arbitraryExport: readerFactory,
      })),
    ).toBe(readerFactory);
    const unrelated = vi.fn();
    expect(
      await loadCodexScheduleCreationInputsFactory(owner("/a.js"), async () => ({ unrelated })),
    ).toBeNull();
    expect(unrelated).not.toHaveBeenCalled();
  });
  it("rejects ambiguous factories and source-marker spoofs without invoking candidates", async () => {
    await expect(
      loadCodexScheduleCreationInputsFactory(owner("/a.js"), async () => ({
        first: factory(),
        second: factory(),
      })),
    ).rejects.toThrow("unavailable");
    const spoof = new Function(
      "scope",
      "host",
      `/* return new scope: hostId: requestClient: dynamicTools:new window.dispatchEvent(new MessageEvent( origin:window.location.origin source:window */ throw Error('must not execute')`,
    );
    expect(
      await loadCodexScheduleCreationInputsFactory(owner("/a.js"), async () => ({ spoof })),
    ).toBeNull();
  });
});
