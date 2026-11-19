/**
 * Chrome for the delegated-children tree codexhost adds to Codex Desktop's sidebar.
 *
 * It follows the Web sidebar tree: the icon of a row with children turns into a chevron on
 * hover and while expanded, a collapsed row carries a one-line summary inside its own block, and
 * expanded children hang from rounded elbow guides 24px per level. The geometry and type are the
 * Web ones (`ThreadTreeControls.module.css`, `Rows.module.css`). Colors come from Desktop's tokens
 * through `var(--token, fallback)`, and Desktop's generated class names are not used: they are not
 * a stable contract. Row metrics (height, radius, icon and title columns) are measured from the
 * native rows at runtime and passed in as `--cxh-*` custom properties.
 */
const STYLE_ATTRIBUTE = "data-codexhost-sidebar-tree-style";

export const SIDEBAR_TREE_TOGGLE_CLASS = "cxh-tree-toggle";
export const SIDEBAR_TREE_CHEVRON_CLASS = "cxh-tree-chevron";
export const SIDEBAR_TREE_SUMMARY_LINE_CLASS = "cxh-tree-summary-line";
export const SIDEBAR_TREE_SUMMARY_CLASS = "cxh-tree-summary";
export const SIDEBAR_TREE_CHILDREN_CLASS = "cxh-tree-children";
export const SIDEBAR_TREE_BRANCH_CLASS = "cxh-tree-branch";
export const SIDEBAR_TREE_ROW_CLASS = "cxh-tree-row";
export const SIDEBAR_TREE_IDENTITY_CLASS = "cxh-tree-identity";
export const SIDEBAR_TREE_TITLE_CLASS = "cxh-tree-title";
export const SIDEBAR_TREE_STATUS_CLASS = "cxh-tree-status";
export const SIDEBAR_TREE_VIRTUAL_CLASS = "cxh-tree-virtual";

/** Each level indents children by the Web tree's 24px. */
export const SIDEBAR_TREE_INDENT_PX = 24;
/** The Agent icon codexhost puts on sidebar rows (`renderer-sidebar-agent-icons`). */
export const SIDEBAR_TREE_ICON_PX = 14;
/** The Web identity control: as wide as the icon, as tall as a line of title text. */
const TOGGLE_HEIGHT_PX = 20;

const ROOT = "[data-codexhost-sidebar-tree-root]";
const COLLAPSED_ROOT = '[data-codexhost-sidebar-tree-root="collapsed"]';
const NATIVE_ROW = "[data-app-action-sidebar-thread-row]";
const ROW_HIGHLIGHTED = `${NATIVE_ROW}:is(:hover, [data-app-action-sidebar-thread-active="true"], [data-app-action-sidebar-thread-selected="true"])`;
const HOVER =
  "var(--color-background-secondary-ghost-hover, color-mix(in srgb, currentColor 10%, transparent))";
const TERTIARY = "var(--color-text-tertiary, color-mix(in srgb, currentColor 60%, transparent))";
const SECONDARY = "var(--color-text-secondary, color-mix(in srgb, currentColor 75%, transparent))";
const PRIMARY = "var(--color-text-primary, currentColor)";
const RUNNING =
  "color-mix(in srgb, var(--color-text-accent, #0285ff), var(--color-text-success, #00a240))";
const PENDING = "var(--color-text-warning, #e25507)";
const RING = "var(--color-ring, Highlight)";
const CURSOR = "var(--cursor-interaction, pointer)";
const CORNER = "var(--codex-corner-shape, round)";
const GUIDE =
  "var(--color-border-heavy, var(--color-border, color-mix(in srgb, currentColor 18%, transparent)))";
const ELBOW =
  'url(\'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 11 8" preserveAspectRatio="none"><path d="M.5 0V1Q.5 3.3 2.5 4.5L10.5 7.5" fill="none" stroke="black" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>\')';

export function ensureRendererSidebarThreadTreeStyle(ownerDocument: Document): void {
  if (ownerDocument.querySelector(`style[${STYLE_ATTRIBUTE}]`)) return;
  const style = ownerDocument.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "true");
  style.textContent = `
    /* Chevron shared by the native-row toggle and codexhost rows. */
    .${SIDEBAR_TREE_CHEVRON_CLASS} {
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      color: ${SECONDARY};
      pointer-events: none;
    }
    .${SIDEBAR_TREE_CHEVRON_CLASS}::before {
      content: "";
      width: 6px;
      height: 6px;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: translateX(-1px) rotate(-45deg);
    }
    [aria-expanded="true"] > .${SIDEBAR_TREE_CHEVRON_CLASS} {
      display: flex;
    }
    [aria-expanded="true"] > .${SIDEBAR_TREE_CHEVRON_CLASS}::before {
      transform: translateY(-1px) rotate(45deg);
    }
    @media (hover: hover) and (pointer: fine) {
      :is(.${SIDEBAR_TREE_TOGGLE_CLASS}, button.${SIDEBAR_TREE_IDENTITY_CLASS}):hover > .${SIDEBAR_TREE_CHEVRON_CLASS} {
        display: flex;
      }
      .${SIDEBAR_TREE_TOGGLE_CLASS}:hover + [data-codexhost-sidebar-agent-icon],
      button.${SIDEBAR_TREE_IDENTITY_CLASS}:hover > :not(.${SIDEBAR_TREE_CHEVRON_CLASS}) {
        visibility: hidden;
      }
    }
    :is(.${SIDEBAR_TREE_TOGGLE_CLASS}, button.${SIDEBAR_TREE_IDENTITY_CLASS}):focus-visible > .${SIDEBAR_TREE_CHEVRON_CLASS} {
      display: flex;
    }
    .${SIDEBAR_TREE_TOGGLE_CLASS}:is(:focus-visible, [aria-expanded="true"]) + [data-codexhost-sidebar-agent-icon],
    button.${SIDEBAR_TREE_IDENTITY_CLASS}:is(:focus-visible, [aria-expanded="true"]) > :not(.${SIDEBAR_TREE_CHEVRON_CLASS}) {
      visibility: hidden;
    }
    :is(.${SIDEBAR_TREE_TOGGLE_CLASS}, button.${SIDEBAR_TREE_IDENTITY_CLASS}):focus-visible {
      outline: 2px solid ${RING};
      outline-offset: 2px;
    }

    /*
     * Toggle laid exactly over the Agent icon of a native row, out of flow, so the icon and the
     * title never move. The hit area reaches past the icon as the Web identity button's does.
     */
    .${SIDEBAR_TREE_TOGGLE_CLASS} {
      all: unset;
      box-sizing: border-box;
      position: absolute;
      z-index: 1;
      width: ${SIDEBAR_TREE_ICON_PX}px;
      height: ${TOGGLE_HEIGHT_PX}px;
      border-radius: 4px;
      cursor: pointer;
    }
    .${SIDEBAR_TREE_TOGGLE_CLASS}::after,
    button.${SIDEBAR_TREE_IDENTITY_CLASS}::after {
      content: "";
      position: absolute;
      inset: -6px -4px -6px -8px;
    }

    /* A collapsed row and its summary read as one block, as in the Web sidebar. */
    ${COLLAPSED_ROOT} ${NATIVE_ROW} {
      border-end-start-radius: 0;
      border-end-end-radius: 0;
    }
    ${COLLAPSED_ROOT}:has(> .${SIDEBAR_TREE_SUMMARY_LINE_CLASS}:hover) ${NATIVE_ROW} {
      background-color: ${HOVER};
    }
    .${SIDEBAR_TREE_SUMMARY_LINE_CLASS} {
      box-sizing: border-box;
      padding-block: 0 2px;
      padding-inline-end: var(--cxh-row-pad-end, 5px);
      border-end-start-radius: var(--cxh-row-radius, 10px);
      border-end-end-radius: var(--cxh-row-radius, 10px);
      corner-shape: ${CORNER};
      cursor: ${CURSOR};
    }
    ${COLLAPSED_ROOT}:has(${ROW_HIGHLIGHTED}) > .${SIDEBAR_TREE_SUMMARY_LINE_CLASS},
    .${SIDEBAR_TREE_SUMMARY_LINE_CLASS}:hover,
    .${SIDEBAR_TREE_BRANCH_CLASS}:has(> .${SIDEBAR_TREE_ROW_CLASS}:is(:hover, [aria-current="page"])) > .${SIDEBAR_TREE_SUMMARY_LINE_CLASS} {
      background: ${HOVER};
    }
    .${SIDEBAR_TREE_BRANCH_CLASS}:has(> .${SIDEBAR_TREE_SUMMARY_LINE_CLASS}) > .${SIDEBAR_TREE_ROW_CLASS} {
      border-end-start-radius: 0;
      border-end-end-radius: 0;
    }
    .${SIDEBAR_TREE_BRANCH_CLASS}:has(> .${SIDEBAR_TREE_SUMMARY_LINE_CLASS}:hover) > .${SIDEBAR_TREE_ROW_CLASS} {
      background: ${HOVER};
    }
    .${SIDEBAR_TREE_SUMMARY_CLASS} {
      all: unset;
      box-sizing: border-box;
      display: block;
      width: calc(100% - var(--cxh-summary-start, 46px) - var(--cxh-indent, 0px));
      min-width: 0;
      margin-inline-start: calc(var(--cxh-summary-start, 46px) + var(--cxh-indent, 0px));
      padding: 2px 8px;
      border-radius: 6px;
      color: ${TERTIARY};
      font-size: 11px;
      line-height: 18px;
      text-align: start;
      overflow-wrap: anywhere;
      cursor: pointer;
    }
    @media (hover: hover) and (pointer: fine) {
      .${SIDEBAR_TREE_SUMMARY_CLASS}:hover {
        background: color-mix(in srgb, ${PRIMARY} 4%, transparent);
      }
    }
    .${SIDEBAR_TREE_SUMMARY_CLASS}:focus-visible {
      outline: 2px solid ${RING};
      outline-offset: -2px;
    }
    .${SIDEBAR_TREE_SUMMARY_CLASS} [data-activity="running"] {
      color: ${RUNNING};
    }
    .${SIDEBAR_TREE_SUMMARY_CLASS} [data-activity="pending"] {
      color: ${PENDING};
    }

    /* Codexhost rows: the same metrics as the native rows of their list. */
    .${SIDEBAR_TREE_ROW_CLASS} {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      min-width: 0;
      height: var(--cxh-row-h, 30px);
      padding-inline-start: calc(var(--cxh-icon-left, 32px) + var(--cxh-indent, 0px));
      padding-inline-end: var(--cxh-row-pad-end, 5px);
      border-radius: var(--cxh-row-radius, 10px);
      corner-shape: ${CORNER};
      color: var(--cxh-title-color, inherit);
      font-size: var(--cxh-title-size, 14px);
      line-height: var(--cxh-title-line, 20px);
      font-weight: var(--cxh-title-weight, inherit);
      cursor: ${CURSOR};
      user-select: none;
      -webkit-user-select: none;
    }
    .${SIDEBAR_TREE_ROW_CLASS}:hover,
    .${SIDEBAR_TREE_ROW_CLASS}[aria-current="page"] {
      background: ${HOVER};
    }
    .${SIDEBAR_TREE_ROW_CLASS}:focus-visible {
      outline: 2px solid ${RING};
      outline-offset: -2px;
    }
    .${SIDEBAR_TREE_IDENTITY_CLASS} {
      all: unset;
      box-sizing: border-box;
      position: relative;
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: ${SIDEBAR_TREE_ICON_PX}px;
      height: ${TOGGLE_HEIGHT_PX}px;
      margin-inline-end: var(--cxh-title-gap, 8px);
      border-radius: 4px;
    }
    button.${SIDEBAR_TREE_IDENTITY_CLASS} {
      cursor: pointer;
    }
    .${SIDEBAR_TREE_TITLE_CLASS} {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .${SIDEBAR_TREE_STATUS_CLASS} {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      margin-inline-start: var(--cxh-title-gap, 8px);
      color: ${TERTIARY};
    }
    .${SIDEBAR_TREE_STATUS_CLASS}[data-status="running"] > svg {
      width: 14px;
      height: 14px;
      animation: cxh-tree-spin 1s linear infinite;
    }
    .${SIDEBAR_TREE_STATUS_CLASS}[data-status="pending"]::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 9999px;
      background: ${PENDING};
    }

    /* Rounded elbow guides, ported from the Web sidebar tree. */
    .${SIDEBAR_TREE_BRANCH_CLASS} {
      position: relative;
      min-width: 0;
      --cxh-icon-cy: calc(var(--cxh-row-h, 30px) / 2);
    }
    .${SIDEBAR_TREE_CHILDREN_CLASS} {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: var(--cxh-gap, 0px);
      margin-top: var(--cxh-gap, 0px);
      --cxh-guide-parent-gap: 12px;
      --cxh-guide-start: calc(
        var(--cxh-guide-parent-gap) - (var(--cxh-row-h, 30px) - ${SIDEBAR_TREE_ICON_PX}px) / 2 -
          var(--cxh-gap, 0px)
      );
      --cxh-guide-axis: calc(
        var(--cxh-icon-left, 32px) + var(--cxh-guide-indent, 0px) + ${SIDEBAR_TREE_ICON_PX / 2}px +
          0.5px
      );
    }
    .${SIDEBAR_TREE_CHILDREN_CLASS} .${SIDEBAR_TREE_CHILDREN_CLASS} {
      --cxh-guide-parent-gap: 10px;
    }
    .${SIDEBAR_TREE_CHILDREN_CLASS}[data-guide]::before,
    .${SIDEBAR_TREE_CHILDREN_CLASS}[data-guide] > .${SIDEBAR_TREE_BRANCH_CLASS}::before {
      content: "";
      position: absolute;
      inset-inline-start: var(--cxh-guide-axis);
      pointer-events: none;
      z-index: 1;
    }
    .${SIDEBAR_TREE_CHILDREN_CLASS}[data-guide]::before {
      top: var(--cxh-guide-start);
      height: max(0px, calc(-1 * var(--cxh-guide-start)));
      width: 1px;
      background: ${GUIDE};
    }
    /* The stem and the elbow share one mask so the translucent token is painted once. */
    .${SIDEBAR_TREE_CHILDREN_CLASS}[data-guide] > .${SIDEBAR_TREE_BRANCH_CLASS}::before {
      --cxh-stem-start: 0px;
      --cxh-stem-end: 0px;
      top: 0;
      bottom: calc(-1 * var(--cxh-gap, 0px));
      width: calc(${SIDEBAR_TREE_INDENT_PX}px - ${SIDEBAR_TREE_ICON_PX / 2}px - 6.5px);
      background: ${GUIDE};
      mask:
        linear-gradient(transparent var(--cxh-stem-start), black 0) 0 0 / 1px
          calc(100% - var(--cxh-stem-end)) no-repeat,
        ${ELBOW} 0 calc(var(--cxh-icon-cy) - 8px) / 100% 8px no-repeat;
    }
    .${SIDEBAR_TREE_CHILDREN_CLASS}[data-guide] > .${SIDEBAR_TREE_BRANCH_CLASS}:first-child::before {
      --cxh-stem-start: max(0px, var(--cxh-guide-start));
    }
    .${SIDEBAR_TREE_CHILDREN_CLASS}[data-guide] > .${SIDEBAR_TREE_BRANCH_CLASS}:last-child::before {
      --cxh-stem-end: 8px;
      bottom: calc(100% - var(--cxh-icon-cy));
    }

    /* A tree drawn in place of a member's row hides that native row. */
    [data-codexhost-sidebar-tree-anchor] > :not(.${SIDEBAR_TREE_VIRTUAL_CLASS}) {
      display: none !important;
    }
    ${ROOT} > .${SIDEBAR_TREE_CHILDREN_CLASS} {
      margin-top: var(--cxh-gap, 0px);
    }

    @keyframes cxh-tree-spin {
      to { transform: rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      .${SIDEBAR_TREE_STATUS_CLASS}[data-status="running"] > svg { animation: none; }
    }
  `;
  (ownerDocument.head ?? ownerDocument.documentElement).append(style);
}

export function removeRendererSidebarThreadTreeStyle(root: ParentNode): void {
  for (const style of root.querySelectorAll(`style[${STYLE_ATTRIBUTE}]`)) style.remove();
}
