import type { IconNode } from "lucide";
import createElement from "lucide/dist/esm/createElement.mjs";
import Box from "lucide/dist/esm/icons/box.mjs";
import CircleOff from "lucide/dist/esm/icons/circle-off.mjs";
import KeyRound from "lucide/dist/esm/icons/key-round.mjs";
import Languages from "lucide/dist/esm/icons/languages.mjs";
import LayoutDashboard from "lucide/dist/esm/icons/layout-dashboard.mjs";
import Network from "lucide/dist/esm/icons/network.mjs";
import Route from "lucide/dist/esm/icons/route.mjs";
import Search from "lucide/dist/esm/icons/search.mjs";
import Server from "lucide/dist/esm/icons/server.mjs";
import Settings from "lucide/dist/esm/icons/settings.mjs";
import X from "lucide/dist/esm/icons/x.mjs";
import codexhostIconUrl from "../assets/codexhost-icon.png";

export const RENDERER_SETTINGS_ICON_NAMES = [
  "settings",
  "search",
  "close",
  "language",
  "overview",
  "routes",
  "providers",
  "credentials",
  "local-models",
  "gateway",
  "unavailable",
] as const;

export type RendererSettingsIconName = (typeof RENDERER_SETTINGS_ICON_NAMES)[number];

const iconNodes = {
  settings: Settings,
  search: Search,
  close: X,
  language: Languages,
  overview: LayoutDashboard,
  routes: Route,
  providers: Server,
  credentials: KeyRound,
  "local-models": Box,
  gateway: Network,
  unavailable: CircleOff,
} satisfies Record<RendererSettingsIconName, IconNode>;

export function isRendererSettingsIconName(value: string): value is RendererSettingsIconName {
  return (RENDERER_SETTINGS_ICON_NAMES as readonly string[]).includes(value);
}

export function createRendererSettingsIcon(name: RendererSettingsIconName, size = 18): SVGElement {
  const icon = createElement(iconNodes[name], {
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
  });
  icon.classList.add("codexhost-settings-icon");
  return icon;
}

export function createRendererSettingsBrandIcon(size = 22): HTMLImageElement {
  const icon = document.createElement("img");
  icon.src = codexhostIconUrl;
  icon.alt = "";
  icon.width = size;
  icon.height = size;
  icon.draggable = false;
  icon.setAttribute("aria-hidden", "true");
  icon.style.width = `${size}px`;
  icon.style.height = `${size}px`;
  icon.style.objectFit = "contain";
  icon.classList.add("codexhost-settings-icon");
  return icon;
}
