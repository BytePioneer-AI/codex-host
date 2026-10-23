import { localizeHarnessText, type ThreadUsageSnapshot } from "@codexhost/shared-contracts";
import type { RendererSettingsLocale } from "./settings/localization.js";
import {
  applyRendererTriggerChipSqueezeRoot,
  ensureRendererTriggerChipStyle,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";

type Indicators = NonNullable<ThreadUsageSnapshot["composerIndicators"]>;

export interface RendererComposerIndicators {
  root: HTMLElement;
  place(anchor: HTMLElement | null): void;
  render(indicators: Indicators, locale: RendererSettingsLocale): void;
  dispose(): void;
}

export function mountRendererComposerIndicators(composer: Element): RendererComposerIndicators {
  const doc = composer.ownerDocument;
  ensureRendererTriggerChipStyle(doc);
  const root = doc.createElement("div");
  root.setAttribute("data-codexhost-composer-indicators", "true");
  applyRendererTriggerChipSqueezeRoot(root, "128px", "0");
  Object.assign(root.style, { alignItems: "center", gap: "2px", flexShrink: "100000" });
  let indicators: Indicators = [];
  let locale: RendererSettingsLocale = "en";
  let timer: ReturnType<typeof setInterval> | undefined;
  let anchor: HTMLElement | null = null;
  let contentKey = "";

  const refresh = (): void => {
    const now = Date.now() / 1000;
    const active = indicators.filter((indicator) => indicator.expiresAtUnix > now);
    const nextKey = JSON.stringify([
      locale,
      active.map((indicator) => [indicator, Math.ceil((indicator.expiresAtUnix - now) / 60)]),
    ]);
    if (nextKey !== contentKey) {
      contentKey = nextKey;
      root.replaceChildren();
      for (const indicator of active) {
        const minutes = Math.ceil((indicator.expiresAtUnix - now) / 60);
        const remaining = locale === "zh-CN" ? `剩余 ${minutes} 分钟` : `${minutes}m remaining`;
        const label = indicator.label ? localizeHarnessText(indicator.label, locale) : "";
        const tooltip = indicator.tooltip ? localizeHarnessText(indicator.tooltip, locale) : "";
        const chip = doc.createElement("span");
        chip.className = TRIGGER_CHIP_CLASS;
        chip.setAttribute("data-indicator-id", indicator.id);
        chip.title = [label, tooltip, remaining].filter(Boolean).join(" · ");
        chip.setAttribute("aria-label", chip.title);
        Object.assign(chip.style, {
          height: "28px",
          padding: "0 6px",
          gap: "4px",
          fontSize: "12px",
          cursor: "default",
          flexShrink: "0",
        });
        const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("width", "14");
        icon.setAttribute("height", "14");
        icon.setAttribute("fill", "none");
        icon.setAttribute("stroke", "currentColor");
        icon.setAttribute("stroke-width", "1.5");
        icon.setAttribute("aria-hidden", "true");
        const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0");
        icon.append(path);
        const text = doc.createElement("span");
        text.textContent = `${minutes}m`;
        chip.append(icon, text);
        root.append(chip);
      }
    }
    const visible = active.length > 0 && anchor !== null;
    if (root.hidden === visible) root.hidden = !visible;
    const display = visible ? "inline-flex" : "none";
    if (root.style.display !== display) root.style.display = display;
    // This optional chip gives up its width before public controls and never shows a clipped clock.
    const visibility = root.scrollWidth > root.clientWidth ? "hidden" : "visible";
    if (root.style.visibility !== visibility) root.style.visibility = visibility;
    if (!active.length && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const observer = new ResizeObserver(refresh);
  observer.observe(root);
  refresh();
  return {
    root,
    place(next) {
      anchor = next;
      if (!next?.parentElement) {
        anchor = null;
        root.remove();
      } else if (next.nextElementSibling !== root) {
        next.parentElement.insertBefore(root, next.nextSibling);
      }
      refresh();
    },
    render(next, nextLocale) {
      indicators = next;
      locale = nextLocale;
      refresh();
      if (
        timer === undefined &&
        indicators.some(({ expiresAtUnix }) => expiresAtUnix > Date.now() / 1000)
      ) {
        timer = setInterval(refresh, 60_000);
      }
    },
    dispose() {
      observer.disconnect();
      if (timer !== undefined) clearInterval(timer);
      root.remove();
    },
  };
}
