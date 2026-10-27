import type {
  DesktopScheduleCreationInputsFactory,
  DesktopScheduleNativeServices,
} from "@codexhost/desktop-control/renderer-bindings";
import { loadCodexNativeServices } from "./codex-native-services.js";

type NativeRegistry = {
  localAutomations: DesktopScheduleNativeServices["localAutomations"];
  localAutomationsScheduler?: unknown;
};
function isScheduleRegistry(value: unknown): value is NativeRegistry {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, "localAutomations"))
    return false;
  const service = (value as NativeRegistry).localAutomations;
  // RPC namespaces are callable proxies. The owning registry supplies identity.
  return (
    service != null &&
    ["list", "update", "delete"].every(
      (key) => typeof service[key as "list" | "update" | "delete"] === "function",
    )
  );
}
export async function loadCodexScheduleServices(
  ownerWindow: Window,
  importModule?: (url: string) => Promise<Record<string, unknown>>,
): Promise<DesktopScheduleNativeServices | null> {
  const registry = await loadCodexNativeServices(ownerWindow, isScheduleRegistry, importModule);
  return registry
    ? {
        localAutomations: registry.localAutomations,
        // Desktop only registers this namespace on the primary window. It owns
        // heartbeat capability/renderer-state reporting, not CRUD persistence.
        isPrimaryWindow:
          Object.hasOwn(registry, "localAutomationsScheduler") &&
          registry.localAutomationsScheduler != null,
      }
    : null;
}

/** Desktop's native creation-input factory has no semantic exported name.
 * This reviewed 26.1021 factory signature constructs its native reader and
 * dynamic-tool dispatcher; its returned scope/client ownership is checked by
 * desktop-control before use. No candidate is invoked during discovery.
 */
function isCreationInputsFactory(value: unknown): value is DesktopScheduleCreationInputsFactory {
  if (typeof value !== "function" || value.length !== 2) return false;
  const source = Function.prototype.toString.call(value).replace(/\s+/gu, "");
  return /^function[\w$]*\(([\w$]+),([\w$]+)\)\{returnnew[\w$]+\(\{scope:\1,hostId:\2,requestClient:\1\.get\([\w$]+,\2\),dynamicTools:new[\w$]+\(\2,([\w$]+)=>\{window\.dispatchEvent\(newMessageEvent\((?:`message`|"message"|'message'),\{data:\3,origin:window\.location\.origin,source:window\}\)\)\}\)\}\)\}$/u.test(
    source,
  );
}
export async function loadCodexScheduleCreationInputsFactory(
  ownerWindow: Window,
  importModule?: (url: string) => Promise<Record<string, unknown>>,
): Promise<DesktopScheduleCreationInputsFactory | null> {
  return loadCodexNativeServices(ownerWindow, isCreationInputsFactory, importModule);
}
