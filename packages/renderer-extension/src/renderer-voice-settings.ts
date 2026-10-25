import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";
import { loadedAssetNames, readCpaLiveVoiceHookConfig } from "./renderer-cpa-live-voice-hook.js";
import { selectVoiceAssets } from "./renderer-voice-assets.js";
import {
  NATIVE_CHAT_VOICE_ASSETS,
  NATIVE_CHAT_VOICE_VERSION,
} from "./renderer-native-chat-voice-assets.js";
import {
  INFERENCE_GATE,
  bindVoiceCapabilitySubscriptions,
  replayVoiceCapability,
} from "./renderer-voice-capability.js";
import {
  bindVoiceSettingsAvailability,
  voiceSettingsSurface,
} from "./renderer-voice-settings-availability.js";
import { bindDictationSettingsMode } from "./renderer-dictation-settings.js";

const GLOBAL = "__codexhostVoiceSettingsV1";
const MESSAGE_ID = "settings.general.realtimeVoice.unavailable.description";
const LABEL = "Voice settings unavailable with this provider";
const DESCRIPTION =
  "Your account allows voice chat. These Desktop settings require the default inference provider. Start ChatGPT Chat voice from the Chat composer.";
type NativeModule = Record<string, unknown>;
type Store = Parameters<typeof replayVoiceCapability>[0];
interface Scope {
  scope: unknown;
  node: { store: Store };
  chain: Map<unknown, unknown>;
  get(selector: unknown, argument?: unknown): unknown;
}
interface Family {
  resolve(
    node: Scope["node"],
    chain: Scope["chain"],
    argument: unknown,
  ): { atom: Parameters<typeof replayVoiceCapability>[1] };
}
interface SettingsModules {
  appScope: { id: unknown };
  page: unknown;
  access: unknown;
  capability: {
    resolve(
      node: Scope["node"],
      chain: Scope["chain"],
      argument: unknown,
    ): {
      resolve(
        node: Scope["node"],
        chain: Scope["chain"],
      ): Parameters<typeof replayVoiceCapability>[1];
    };
  };
  gates: Family;
  dictationMode?: {
    resolve(
      node: Scope["node"],
      chain: Scope["chain"],
    ): Parameters<typeof replayVoiceCapability>[1];
  };
}
const record = (value: unknown): value is NativeModule =>
  value !== null && typeof value === "object";
const settled = (value: unknown, isCapable: boolean) =>
  record(value) &&
  value.isLoading === false &&
  value.isError === false &&
  value.isCapable === isCapable;

function realtimeAtoms(scope: Scope, modules: SettingsModules) {
  const atom = modules.capability
    .resolve(scope.node, scope.chain, { name: "voice.realtime" })
    .resolve(scope.node, scope.chain);
  return {
    atom,
    gate: modules.gates.resolve(scope.node, scope.chain, INFERENCE_GATE).atom,
  };
}

/** Explain only the provider-only rejection; entitlement and native state stay unchanged. */
export function providerBlocksVoiceSettings(scope: Scope, modules: SettingsModules): boolean {
  try {
    const access = scope.get(modules.access);
    if (
      !record(access) ||
      access.status !== "allowed" ||
      !settled(scope.get(modules.capability, { name: "voice" }), true) ||
      !settled(scope.get(modules.capability, { name: "voice.realtime" }), false)
    )
      return false;
    const { atom, gate } = realtimeAtoms(scope, modules);
    return replayVoiceCapability(scope.node.store, atom, gate)?.isCapable === true;
  } catch {
    return false;
  }
}

/** Match the native Settings row by message identity and exported page ownership.
 * Text-only hosts preserve React's nodes and can be restored when policy changes.
 */
export function explainVoiceSettingsRestriction(
  doc: Document,
  modules: SettingsModules,
): { current(): boolean; dispose(): void } | undefined {
  const descriptions: { element: Element; label: Element; scope: Scope }[] = [];
  for (const element of doc.querySelectorAll("section div")) {
    if (element.childNodes.length !== 1 || element.firstChild?.nodeType !== 3) continue;
    const key = Object.getOwnPropertyNames(element).find((key) => key.startsWith("__reactFiber$"));
    const ancestors = committedReactAncestors(
      key && Object.getOwnPropertyDescriptor(element, key)?.value,
    );
    if (!ancestors.some((fiber) => fiber.type === modules.page)) continue;
    const owner = ancestors.find(
      ({ memoizedProps: props }) =>
        record(props) &&
        record(props.description) &&
        record(props.description.props) &&
        props.description.props.id === MESSAGE_ID &&
        props.control === null,
    );
    const props = owner?.memoizedProps;
    if (
      !record(props) ||
      !record(props.description) ||
      !record(props.description.props) ||
      !record(props.label) ||
      !record(props.label.props) ||
      element.textContent !== props.description.props.defaultMessage
    )
      continue;
    const labelText = props.label.props.defaultMessage;
    if (typeof labelText !== "string") continue;
    // The native row's nearest host ancestor contains its label and description.
    const row = ancestors.find((fiber) => {
      const host = fiber.stateNode as Element | undefined;
      return (
        fiber.tag === 5 &&
        host !== element &&
        typeof host?.contains === "function" &&
        host.contains(element) &&
        host.textContent?.includes(labelText)
      );
    });
    const host = row?.stateNode as Element | undefined;
    const labels = host
      ? [...host.querySelectorAll("div")].filter(
          (node) =>
            node.childNodes.length === 1 &&
            node.firstChild?.nodeType === 3 &&
            node.textContent === labelText,
        )
      : [];
    if (labels.length !== 1) continue;
    const scopes = new Map<unknown, Scope>();
    for (const fiber of ancestors) {
      let hook = fiber.memoizedState;
      const seen = new Set<unknown>();
      while (record(hook) && seen.size < 4096 && !seen.has(hook)) {
        seen.add(hook);
        const scope = record(hook.memoizedState) ? hook.memoizedState.current : undefined;
        if (
          record(scope) &&
          scope.scope === modules.appScope &&
          record(scope.node) &&
          scope.chain instanceof Map &&
          scope.chain.get(modules.appScope.id) === scope.node &&
          typeof scope.get === "function"
        )
          scopes.set(scope.node, scope as unknown as Scope);
        hook = hook.next;
      }
    }
    const label = labels[0];
    const scope = [...scopes.values()][0];
    if (scopes.size === 1 && label && scope) descriptions.push({ element, label, scope });
  }
  const current = descriptions.length === 1 ? descriptions[0] : undefined;
  if (!current) return;
  if (!providerBlocksVoiceSettings(current.scope, modules)) return;
  const changes = [
    [current.element, DESCRIPTION],
    [current.label, LABEL],
  ] as const;
  const restores = changes.map(([element, replacement]) => {
    const text = element.firstChild as Text;
    const previous = text.data;
    text.data = replacement;
    return () => {
      if (text.data === replacement) text.data = previous;
    };
  });
  return {
    current() {
      return (
        changes.every(
          ([element, replacement]) => element.isConnected && element.textContent === replacement,
        ) && providerBlocksVoiceSettings(current.scope, modules)
      );
    },
    dispose() {
      for (const restore of restores) restore();
    },
  };
}

/** Restore the native voice and dictation controls through owned Settings readers.
 * Account policy and all non-provider capability dependencies remain native.
 */
export function restoreNativeVoiceSettings(
  doc: Document,
  modules: SettingsModules,
  enabled: () => boolean = () => true,
): { current(): boolean; dispose(): void } | undefined {
  const surface = voiceSettingsSurface(doc, modules.page, modules.appScope);
  if (!surface || !providerBlocksVoiceSettings(surface.scope, modules)) return;
  const scope = surface.scope;
  const currentFibers = () => {
    const current = voiceSettingsSurface(doc, modules.page, modules.appScope);
    return current?.scope.node === scope.node ? current.fibers : new Set<Record<string, unknown>>();
  };
  const allowed = () => enabled() && providerBlocksVoiceSettings(scope, modules);
  const { atom, gate } = realtimeAtoms(scope, modules);
  const capability = bindVoiceCapabilitySubscriptions(
    () => new Set([...currentFibers()].filter((fiber) => fiber.type === modules.page)),
    modules.capability as unknown as Parameters<typeof bindVoiceCapabilitySubscriptions>[1],
    modules.gates as Parameters<typeof bindVoiceCapabilitySubscriptions>[2],
    allowed,
    false,
    ["voice.realtime", "dictation.composer", "dictation.global"],
  );
  let availability: ReturnType<typeof bindVoiceSettingsAvailability> | undefined;
  try {
    availability = bindVoiceSettingsAvailability(
      currentFibers,
      scope.node.store,
      atom,
      gate,
      allowed,
    );
    const dictationMode =
      modules.dictationMode &&
      bindDictationSettingsMode(
        currentFibers,
        scope.node.store,
        modules.dictationMode.resolve(scope.node, scope.chain),
        ["dictation.composer", "dictation.global", "dictation.chatgpt"].map((name) =>
          modules.capability
            .resolve(scope.node, scope.chain, { name })
            .resolve(scope.node, scope.chain),
        ),
        gate,
        enabled,
      );
    const voiceAvailability = availability;
    return {
      current: () =>
        allowed() &&
        capability.current() &&
        voiceAvailability.current() &&
        (dictationMode?.current() ?? true),
      dispose() {
        dictationMode?.dispose();
        voiceAvailability.dispose();
        capability.dispose();
      },
    };
  } catch (error) {
    availability?.dispose();
    capability.dispose();
    throw error;
  }
}

export function installVoiceSettingsExplanation(
  options: {
    target?: typeof globalThis;
    importModule?: (url: string) => Promise<NativeModule>;
  } = {},
): { dispose(): void } {
  const target = options.target ?? globalThis;
  const globals = target as unknown as NativeModule;
  if (globals[GLOBAL]) return globals[GLOBAL] as { dispose(): void };
  const config = readCpaLiveVoiceHookConfig(target);
  if (!config) return { dispose() {} };
  if (config.desktopVersion && config.desktopVersion !== NATIVE_CHAT_VOICE_VERSION)
    return { dispose() {} };
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let binding: ReturnType<typeof explainVoiceSettingsRestriction>;
  let modules: SettingsModules | undefined;
  let restored = false;
  const handle = {
    dispose() {
      disposed = true;
      if (timer !== undefined) target.clearTimeout(timer);
      binding?.dispose();
      if (globals[GLOBAL] === handle) Reflect.deleteProperty(globals, GLOBAL);
    },
  };
  globals[GLOBAL] = handle;
  const tryControls = () => {
    if (!modules || !target.document) return;
    try {
      return restoreNativeVoiceSettings(
        target.document,
        modules,
        () => !!readCpaLiveVoiceHookConfig(target),
      );
    } catch {
      return undefined;
    }
  };
  const refresh = async () => {
    if (disposed) return;
    try {
      if (binding?.current()) {
        if (restored) return;
        // Passive subscription effects can settle after the explanation mounts.
        // Retry controls without rewriting the explanatory text on each poll.
        const controls = tryControls();
        if (controls) {
          binding.dispose();
          binding = controls;
          restored = true;
        }
        return;
      }
      binding?.dispose();
      binding = undefined;
      restored = false;
      if (!modules) {
        // Document-start can expose one native chunk before its shared dependency.
        // Keep the installer alive until the audited pair has finished loading.
        const assets = selectVoiceAssets(
          NATIVE_CHAT_VOICE_ASSETS,
          loadedAssetNames(target.document, target.performance),
          config.desktopVersion,
        );
        if (!assets?.settings) return;
        const load = options.importModule ?? ((url: string) => import(url));
        const [initial, shared, settings] = await Promise.all(
          [assets.initial, assets.shared, assets.settings].map((asset) =>
            load(`app://-/assets/${asset}`),
          ),
        );
        if (disposed) return;
        if (typeof initial.l0n !== "function" || typeof settings.VoiceSettings !== "function")
          return;
        initial.l0n();
        const dictationMode = initial.mW as SettingsModules["dictationMode"];
        modules = {
          appScope: shared.Bst as SettingsModules["appScope"],
          page: settings.VoiceSettings,
          access: initial.k5n,
          capability: initial.c0n as SettingsModules["capability"],
          gates: initial.Cnr as Family,
          ...(dictationMode ? { dictationMode } : {}),
        };
      }
      if (target.document) {
        binding = tryControls();
        restored = !!binding;
        if (!binding) binding = explainVoiceSettingsRestriction(target.document, modules);
      }
    } catch {
      /* Unknown Settings layouts retain the native explanation. */
    } finally {
      if (!disposed) timer = target.setTimeout(() => void refresh(), 1000);
    }
  };
  void refresh();
  return handle;
}
