import type { IconNode } from "lucide";
import createElement from "lucide/dist/esm/createElement.mjs";
import Boxes from "lucide/dist/esm/icons/boxes.mjs";
import ChevronLeft from "lucide/dist/esm/icons/chevron-left.mjs";
import ChevronRight from "lucide/dist/esm/icons/chevron-right.mjs";
import CircleOff from "lucide/dist/esm/icons/circle-off.mjs";
import Copy from "lucide/dist/esm/icons/copy.mjs";
import Download from "lucide/dist/esm/icons/download.mjs";
import ExternalLink from "lucide/dist/esm/icons/external-link.mjs";
import Languages from "lucide/dist/esm/icons/languages.mjs";
import Network from "lucide/dist/esm/icons/network.mjs";
import PlugZap from "lucide/dist/esm/icons/plug-zap.mjs";
import RefreshCw from "lucide/dist/esm/icons/refresh-cw.mjs";
import Route from "lucide/dist/esm/icons/route.mjs";
import Settings from "lucide/dist/esm/icons/settings.mjs";
import Stethoscope from "lucide/dist/esm/icons/stethoscope.mjs";
import Star from "lucide/dist/esm/icons/star.mjs";
import X from "lucide/dist/esm/icons/x.mjs";
import codexLogoUrl from "../assets/codex-logo-bright.png";

export const RENDERER_SETTINGS_ICON_NAMES = [
  "settings",
  "close",
  "star",
  "language",
  "connections",
  "model-pool",
  "routes",
  "gateway",
  "updates",
  "external-link",
  "refresh",
  "unavailable",
  "diagnose",
  "copy",
  "download",
  "chevron-left",
  "chevron-right",
] as const;

export type RendererSettingsIconName = (typeof RENDERER_SETTINGS_ICON_NAMES)[number];

const iconNodes = {
  settings: Settings,
  close: X,
  star: Star,
  language: Languages,
  connections: PlugZap,
  "model-pool": Boxes,
  routes: Route,
  gateway: Network,
  updates: Download,
  "external-link": ExternalLink,
  refresh: RefreshCw,
  unavailable: CircleOff,
  diagnose: Stethoscope,
  copy: Copy,
  download: Download,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
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
  icon.src = codexLogoUrl;
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
