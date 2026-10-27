import { loadCodexNativeServices } from "./codex-native-services.js";

interface ClipboardService {
  writeText(text: string): Promise<unknown>;
}
interface ClipboardServices {
  clipboard: ClipboardService;
}
function matchesServices(value: unknown): value is ClipboardServices {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, "clipboard"))
    return false;
  const clipboard = (value as ClipboardServices).clipboard;
  // Desktop's RPC service can be a callable proxy rather than a plain object.
  return clipboard != null && typeof clipboard.writeText === "function";
}

/** Transform only the selected Thread's native clipboard write; preserve every other RPC member. */
export async function installCodexThreadClipboard(
  ownerWindow: Window,
  transform: (text: string) => Promise<string>,
): Promise<(() => void) | null> {
  const services = await loadCodexNativeServices(ownerWindow, matchesServices);
  if (!services) return null;
  const original = services.clipboard;
  const write = original.writeText;
  let active = true;
  const writeText = async (text: string) => {
    if (!active) return Reflect.apply(write, original, [text]);
    const transformed = await transform(text);
    return Reflect.apply(write, original, [active ? transformed : text]);
  };
  const wrapped = new Proxy(original, {
    get: (target, property, receiver) =>
      property === "writeText" ? writeText : Reflect.get(target, property, receiver),
  });
  if (!Reflect.set(services, "clipboard", wrapped) || services.clipboard !== wrapped) return null;
  return () => {
    active = false;
    if (services.clipboard === wrapped) Reflect.set(services, "clipboard", original);
  };
}
