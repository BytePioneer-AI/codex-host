import createElement from "lucide/dist/esm/createElement.mjs";
import Star from "lucide/dist/esm/icons/star.mjs";

const STYLE_ATTRIBUTE = "data-codexhost-model-option-style";

export function ensureModelOptionStyle(ownerDocument: Document): void {
  if (ownerDocument.querySelector(`style[${STYLE_ATTRIBUTE}]`)) return;
  const style = ownerDocument.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "true");
  style.textContent = `
    [data-codexhost-model-row] {
      display: flex;
      align-items: center;
      border-radius: 8px;
      padding: 0 4px;
    }
    [data-codexhost-model-row]:hover,
    [data-codexhost-model-row]:focus-within {
      background: var(--color-token-list-hover-background, rgba(127, 127, 127, .07));
    }
    [data-codexhost-model-row] > button[data-model-id] {
      background: transparent;
      min-height: 36px;
    }
    [data-codexhost-model-row] > button[data-favorite-model-id] {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      width: 24px;
      height: 24px;
      padding: 4px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--color-token-border, #dcdce2);
      cursor: pointer;
    }
    [data-codexhost-model-row] > button[data-favorite-model-id]:hover {
      background: var(--color-token-list-hover-background, rgba(127, 127, 127, .09));
      color: var(--color-token-text-secondary, #85858f);
    }
    [data-codexhost-model-row] > button[data-favorite-model-id][aria-pressed="true"] {
      color: #f59e0b;
    }
    [data-codexhost-model-row] button:focus-visible {
      outline: 2px solid var(--color-token-text-secondary, #85858f);
      outline-offset: -2px;
    }
    [data-favorite-model-id] > svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linejoin: round;
    }
    [data-favorite-model-id][aria-pressed="true"] > svg {
      fill: currentColor;
    }
  `;
  (ownerDocument.head ?? ownerDocument.documentElement).append(style);
}

export function createModelFavoriteIcon(ownerDocument: Document): SVGElement {
  // Match Paseo's FavoriteStar: Lucide Star, ICON_SIZE.md (16), default stroke 2.
  return ownerDocument.adoptNode(
    createElement(Star, {
      width: 16,
      height: 16,
      "aria-hidden": "true",
      focusable: "false",
    }),
  );
}
