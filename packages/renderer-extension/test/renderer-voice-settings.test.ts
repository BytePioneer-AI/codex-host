import { afterEach, describe, expect, it, vi } from "vitest";
import {
  explainVoiceSettingsRestriction,
  installVoiceSettingsExplanation,
  providerBlocksVoiceSettings,
  restoreNativeVoiceSettings,
} from "../src/renderer-voice-settings.js";

type Atom = { read(get: (atom: Atom) => unknown): unknown; write?: unknown };
function fixture() {
  const appScope = { id: Symbol() };
  const page = () => {};
  const access = {};
  let status = "allowed";
  let rootCapable = true;
  let otherRestriction = false;
  let loading = false;
  let error = false;
  const gate: Atom = { read: () => true, write: true };
  const atom: Atom = {
    read: (get) => ({
      isLoading: loading,
      isError: error,
      isCapable: !otherRestriction && get(gate) === false,
    }),
  };
  const store = {
    get: (atom: Atom): unknown => atom.read(store.get),
    sub: vi.fn((atom: Atom, listener: () => void) => {
      void atom;
      void listener;
      return () => {};
    }),
  };
  const capability = { resolve: () => ({ resolve: () => atom }) };
  const gates = { resolve: () => ({ atom: gate }) };
  const modules = { appScope, page, access, capability, gates };
  const node = { store };
  const scope = {
    scope: appScope,
    node,
    chain: new Map([[appScope.id, node]]),
    get: (selector: unknown, arg?: unknown) =>
      selector === access
        ? { status }
        : (arg as { name: string })?.name === "voice"
          ? { isLoading: false, isError: false, isCapable: rootCapable }
          : store.get(atom),
  };
  const nativeLabel = "Voice chat unavailable";
  const nativeDescription = "Your account or workspace does not have access to voice chat";
  const textElement = (value: string) => {
    let data = value;
    const text = {
      nodeType: 3,
      get data() {
        return data;
      },
      set data(value: string) {
        data = value;
      },
    };
    return {
      isConnected: true,
      firstChild: text,
      childNodes: [text],
      get textContent() {
        return text.data;
      },
    };
  };
  const label = textElement(nativeLabel);
  const description = textElement(nativeDescription);
  const host = {
    contains: (el: unknown) => el === description || el === label,
    get textContent() {
      return label.textContent + description.textContent;
    },
    querySelectorAll: () => [label, description],
  };
  const pageFiber = {
    type: page,
    memoizedState: { memoizedState: { current: scope }, next: null },
    return: null,
  };
  const row = {
    memoizedProps: {
      control: null,
      label: { props: { defaultMessage: nativeLabel } },
      description: {
        props: {
          id: "settings.general.realtimeVoice.unavailable.description",
          defaultMessage: nativeDescription,
        },
      },
    },
    return: pageFiber,
  };
  Object.assign(description, {
    __reactFiber$fixture: {
      tag: 5,
      stateNode: description,
      return: { tag: 5, stateNode: host, return: row },
    },
  });
  const doc = {
    querySelectorAll: (selector: string) => (selector === "section div" ? [description] : []),
  } as unknown as Document;
  return {
    scope,
    modules,
    doc,
    label,
    description,
    nativeLabel,
    nativeDescription,
    store,
    gate,
    atom,
    pageFiber,
    setStatus: (s: string) => {
      status = s;
    },
    blockRoot: () => {
      rootCapable = false;
    },
    otherRestriction: () => {
      otherRestriction = true;
    },
    loading: () => {
      loading = true;
    },
    error: () => {
      error = true;
    },
  };
}

describe("voice Settings provider explanation", () => {
  it("identifies an allowed account blocked only by the inference restriction without changing native state", () => {
    const f = fixture();
    expect(providerBlocksVoiceSettings(f.scope, f.modules)).toBe(true);
    expect(f.store.get(f.gate)).toBe(true);
    expect(f.store.get(f.atom)).toMatchObject({ isCapable: false });
    expect(f.store.sub).not.toHaveBeenCalled();
  });
  it.each(["denied", "loading", "error", "unknown"])("preserves real access state %s", (status) => {
    const f = fixture();
    f.setStatus(status);
    expect(providerBlocksVoiceSettings(f.scope, f.modules)).toBe(false);
    explainVoiceSettingsRestriction(f.doc, f.modules);
    expect(f.description.textContent).toBe(f.nativeDescription);
  });
  it.each(["blockRoot", "otherRestriction", "loading", "error"] as const)(
    "does not misdiagnose another capability restriction: %s",
    (change) => {
      const f = fixture();
      f[change]();
      expect(providerBlocksVoiceSettings(f.scope, f.modules)).toBe(false);
    },
  );
  it("changes and restores only the native owned Settings text nodes", () => {
    const f = fixture();
    const original = f.description.firstChild;
    const restore = explainVoiceSettingsRestriction(f.doc, f.modules);
    expect(f.description.firstChild).toBe(original);
    expect(f.label.textContent).toBe("Voice settings unavailable with this provider");
    expect(f.description.textContent).toContain("Your account allows voice chat");
    expect(restore?.current()).toBe(true);
    f.setStatus("denied");
    expect(restore?.current()).toBe(false);
    restore?.dispose();
    expect(f.description.textContent).toBe(f.nativeDescription);
    expect(f.label.textContent).toBe(f.nativeLabel);
  });
  it("does not change matching transcript text or an ambiguous Settings surface", () => {
    const f = fixture();
    const original = f.pageFiber.type;
    f.pageFiber.type = () => {};
    explainVoiceSettingsRestriction(f.doc, f.modules);
    expect(f.description.textContent).toBe(f.nativeDescription);
    f.pageFiber.type = original;
    const ambiguous = {
      querySelectorAll: () => [f.description, f.description],
    } as unknown as Document;
    explainVoiceSettingsRestriction(ambiguous, f.modules);
    expect(f.description.textContent).toBe(f.nativeDescription);
  });
  it("does not overwrite a native text update during restoration", () => {
    const f = fixture();
    const restore = explainVoiceSettingsRestriction(f.doc, f.modules);
    f.description.firstChild.data = "Checking voice chat access…";
    restore?.dispose();
    expect(f.description.textContent).toBe("Checking voice chat access…");
  });
});

afterEach(() => vi.useRealTimers());
describe("voice Settings explanation lifecycle", () => {
  it("restores the native denial when account access changes, without rewriting unchanged text on each poll", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const target = {
      __codexhostCpaLiveVoiceHookV1: {
        enabled: true,
        desktopVersion: "26.1021.31345",
        auditedDesktopVersion: "26.1007.30912",
        auditedAppInitialAsset: "app-initial-6350d04672d0.js",
      },
      document: f.doc,
      performance: { getEntriesByType: () => [] },
      setTimeout,
      clearTimeout,
    } as unknown as typeof globalThis;
    const importModule = vi.fn(async (url: string): Promise<Record<string, unknown>> => {
      if (url.includes("app-initial"))
        return {
          l0n: vi.fn(),
          k5n: f.modules.access,
          c0n: f.modules.capability,
          Cnr: f.modules.gates,
        };
      if (url.includes("app-shared")) return { Bst: f.modules.appScope };
      return { VoiceSettings: f.modules.page };
    });
    const hook = installVoiceSettingsExplanation({ target, importModule });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.description.textContent).toContain("Your account allows voice chat");
      const setter = vi.spyOn(f.description.firstChild, "data", "set");
      await vi.advanceTimersByTimeAsync(1000);
      expect(setter).not.toHaveBeenCalled();
      f.setStatus("denied");
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.description.textContent).toBe(f.nativeDescription);
    } finally {
      hook.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

function controlsFixture(withDictation = false) {
  const f = fixture();
  const family = Object.assign(f.modules.capability, { scope: f.modules.appScope });
  const cacheKey = {};
  Object.assign(f.scope.node, {
    familyBindings: new Map([
      [family, new Map([[JSON.stringify({ name: "voice.realtime" }), { cacheKey }]])],
    ]),
  });
  function subscription(atom: typeof f.atom, deps: unknown[]) {
    const original = () => f.store.get(atom);
    const subscriber = {
      getSnapshot: original,
      subscribe: (notify: () => void) => f.store.sub(atom, notify),
      createRender: () => undefined,
    };
    const instance = { getSnapshot: original };
    const hook = {
      memoizedState: [subscriber, deps],
      next: {
        memoizedState: original(),
        queue: instance,
        next: {
          memoizedState: {
            create: () => {
              f.store.sub(atom, () => {
                hook.next.memoizedState = subscriber.getSnapshot();
              });
            },
            deps: [subscriber.subscribe],
          },
          next: null,
        },
      },
    };
    return { subscriber, instance, hook, original };
  }
  const signal = { atom: f.atom, store: f.store };
  const capability = subscription(f.atom, [signal, undefined]);
  const boolean = {
    read: (get: (atom: typeof f.atom) => unknown) =>
      (get(f.atom) as { isCapable: boolean }).isCapable,
  };
  const availability = subscription(boolean, [f.store, boolean]);
  const scopeHook = f.pageFiber.memoizedState;
  Object.assign(scopeHook, {
    next: {
      memoizedState: [signal, [cacheKey, f.scope.chain, undefined, family, undefined]],
      next: capability.hook,
    },
  });
  const group = { memoizedState: availability.hook, return: f.pageFiber };
  let dictationAllowed = true;
  const dictationAtom: Atom = {
    read: (get) => ({
      isLoading: false,
      isError: false,
      isCapable: dictationAllowed && !get(f.gate),
    }),
  };
  const modeAtom: Atom = {
    read: (get) => ((get(dictationAtom) as { isCapable: boolean }).isCapable ? "os-global" : null),
  };
  const dictation = subscription(modeAtom, [f.store, modeAtom]);
  if (withDictation) {
    const resolve = f.modules.capability.resolve;
    Object.assign(f.modules.capability, {
      resolve: (_node: unknown, _chain: unknown, arg: { name: string }) =>
        arg.name.startsWith("dictation") ? { resolve: () => dictationAtom } : resolve(),
    });
    Object.assign(f.modules, { dictationMode: { resolve: () => modeAtom } });
    let tail = capability.hook.next.next;
    for (const name of ["dictation.composer", "dictation.global"]) {
      const key = {};
      const members = (
        f.scope.node as typeof f.scope.node & {
          familyBindings: Map<unknown, Map<string, { cacheKey: unknown }>>;
        }
      ).familyBindings.get(family);
      members?.set(JSON.stringify({ name }), { cacheKey: key });
      const signal = { atom: dictationAtom, store: f.store };
      const reader = subscription(dictationAtom, [signal, undefined]);
      Object.assign(tail, {
        next: {
          memoizedState: [signal, [key, f.scope.chain, undefined, family, undefined]],
          next: reader.hook,
        },
      });
      tail = reader.hook.next.next;
    }
    Object.assign(availability.hook.next.next, { next: dictation.hook });
  }
  const section = { __reactFiber$controls: { return: group } };
  let controlsReady = true;
  const doc = {
    querySelectorAll: (selector: string) =>
      selector === "section" ? (controlsReady ? [section] : []) : f.doc.querySelectorAll(selector),
  } as unknown as Document;
  return {
    ...f,
    doc,
    capability,
    availability,
    dictation,
    modeAtom,
    dictationAtom,
    denyDictation: () => {
      dictationAllowed = false;
    },
    group,
    setControlsReady: (ready: boolean) => {
      controlsReady = ready;
    },
  };
}

describe("native Settings controls restoration", () => {
  it("commits both owned readers, preserves native policy, and restores on disposal", () => {
    const f = controlsFixture();
    const binding = restoreNativeVoiceSettings(f.doc, f.modules);
    expect(binding?.current()).toBe(true);
    expect(f.capability.subscriber.getSnapshot()).toMatchObject({ isCapable: true });
    expect(f.availability.subscriber.getSnapshot()).toBe(true);
    expect(f.scope.get(f.modules.access)).toEqual({ status: "allowed" });
    expect(f.store.get(f.atom)).toMatchObject({ isCapable: false });
    f.setStatus("denied");
    expect(binding?.current()).toBe(false);
    expect(f.availability.subscriber.getSnapshot()).toBe(false);
    binding?.dispose();
    expect(f.capability.subscriber.getSnapshot).toBe(f.capability.original);
    expect(f.availability.subscriber.getSnapshot).toBe(f.availability.original);
  });
  it("restores dictation settings and native OS handler mode while preserving independent dictation policy", () => {
    const f = controlsFixture(true);
    const binding = restoreNativeVoiceSettings(f.doc, f.modules);
    expect(binding?.current()).toBe(true);
    expect(f.dictation.subscriber.getSnapshot()).toBe("os-global");
    expect(f.store.get(f.modeAtom)).toBeNull();
    expect(f.store.get(f.dictationAtom)).toMatchObject({ isCapable: false });
    f.denyDictation();
    expect(f.dictation.subscriber.getSnapshot()).toBeNull();
    expect(f.availability.subscriber.getSnapshot()).toBe(true);
    binding?.dispose();
    expect(f.dictation.subscriber.getSnapshot).toBe(f.dictation.original);
  });

  it("rolls back the capability reader when the group's boolean subscription is unavailable", () => {
    const f = controlsFixture();
    f.group.memoizedState = null as unknown as typeof f.group.memoizedState;
    expect(() => restoreNativeVoiceSettings(f.doc, f.modules)).toThrow();
    expect(f.capability.subscriber.getSnapshot).toBe(f.capability.original);
    expect(f.capability.instance.getSnapshot).toBe(f.capability.original);
  });
  it.each(["denied", "loading", "error"])("never binds a genuinely %s account", (status) => {
    const f = controlsFixture();
    f.setStatus(status);
    expect(restoreNativeVoiceSettings(f.doc, f.modules)).toBeUndefined();
    expect(f.capability.subscriber.getSnapshot).toBe(f.capability.original);
  });
});

it("retries controls after passive subscription readiness while retaining the fallback explanation", async () => {
  vi.useFakeTimers();
  const f = controlsFixture();
  f.setControlsReady(false);
  const target = {
    __codexhostCpaLiveVoiceHookV1: {
      enabled: true,
      desktopVersion: "26.1021.31345",
      auditedDesktopVersion: "26.1007.30912",
      auditedAppInitialAsset: "app-initial-6350d04672d0.js",
    },
    document: f.doc,
    performance: { getEntriesByType: () => [] },
    setTimeout,
    clearTimeout,
  } as unknown as typeof globalThis;
  const importModule = async (url: string): Promise<Record<string, unknown>> =>
    url.includes("app-initial")
      ? { l0n: () => {}, k5n: f.modules.access, c0n: f.modules.capability, Cnr: f.modules.gates }
      : url.includes("app-shared")
        ? { Bst: f.modules.appScope }
        : { VoiceSettings: f.modules.page };
  const hook = installVoiceSettingsExplanation({ target, importModule });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(f.description.textContent).toContain("Your account allows voice chat");
    f.setControlsReady(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.capability.subscriber.getSnapshot()).toMatchObject({ isCapable: true });
    expect(f.availability.subscriber.getSnapshot()).toBe(true);
    expect(f.description.textContent).toBe(f.nativeDescription);
  } finally {
    hook.dispose();
  }
  expect(f.capability.subscriber.getSnapshot).toBe(f.capability.original);
});
